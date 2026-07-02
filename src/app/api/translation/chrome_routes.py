"""
Chrome 扩展专用路由：/api/chrome/translate-image

将检测 → OCR → 颜色提取 → 翻译 → 修复 → 渲染 串成一条完整的流水线，
返回翻译后的图片供 Chrome 扩展直接展示。
"""

import base64
import io
import logging
import numpy as np
from PIL import Image
from flask import jsonify, request

from src.core.detection import get_bubble_detection_result_with_auto_directions
from src.core.ocr import recognize_ocr_results_in_bubbles
from src.core.ocr_types import extract_texts_from_ocr_results
from src.core.translation import translate_text_list
from src.core.inpainting import inpaint_bubbles
from src.core.rendering import render_bubbles_unified
from src.core.config_models import BubbleState
from src.core.color_extractor import extract_bubble_colors
from src.shared import constants
from src.shared.ai_providers import normalize_provider_id

from . import translate_bp

logger = logging.getLogger("ChromeAPI")


def _decode_base64_image(base64_str: str) -> np.ndarray:
    if "," in base64_str:
        base64_str = base64_str.split(",")[1]
    image_data = base64.b64decode(base64_str)
    image = Image.open(io.BytesIO(image_data))
    if image.mode != "RGB":
        image = image.convert("RGB")
    return np.array(image)


def _encode_image_to_base64(image: np.ndarray) -> str:
    pil_image = Image.fromarray(image)
    buffer = io.BytesIO()
    pil_image.save(buffer, format="JPEG", quality=92)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _rgb_to_hex(rgb):
    if rgb is None:
        return None
    return "#{:02x}{:02x}{:02x}".format(rgb[0], rgb[1], rgb[2])


@translate_bp.route("/chrome/translate-image", methods=["POST"])
def chrome_translate_image():
    """完整翻译流水线：检测 -> OCR -> 颜色提取 -> 翻译 -> 修复 -> 渲染"""
    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get("image_data")
        if not image_data:
            return jsonify({"success": False, "error": "缺少图片数据"}), 400

        # 1. 解码图片
        img = _decode_base64_image(image_data)
        img_pil = Image.fromarray(img)

        # 2. 检测气泡
        model_provider = normalize_provider_id(data.get("model_provider", "deepseek"))

        detect_result = get_bubble_detection_result_with_auto_directions(img_pil)
        coords = detect_result.get("coords", [])
        polygons = detect_result.get("polygons", [])
        raw_mask = detect_result.get("raw_mask")
        textlines_per_bubble = detect_result.get("textlines_per_bubble", [])

        if not coords:
            return jsonify({
                "success": True,
                "translated_image": image_data,
                "original_texts": [],
                "translated_texts": [],
                "bubble_count": 0,
                "warning": "no_bubbles_detected",
            })

        # 3. OCR 识别
        source_language = data.get("source_language", "japanese")
        ocr_engine = data.get("ocr_engine", "manga_ocr")
        ocr_results = recognize_ocr_results_in_bubbles(
            img_pil, coords,
            source_language=source_language,
            ocr_engine=ocr_engine,
            # 允许非英文OCR引擎也获取到语言信息进行优化
            textlines_per_bubble=textlines_per_bubble,
        )
        original_texts = extract_texts_from_ocr_results(ocr_results)

        if not original_texts or all(not t.strip() for t in original_texts):
            return jsonify({
                "success": True,
                "translated_image": image_data,
                "original_texts": [],
                "translated_texts": [],
                "bubble_count": len(coords),
                "warning": "ocr_no_text",
            })

        # 4. 颜色提取
        colors = extract_bubble_colors(img_pil, coords, textlines_per_bubble)

        # 5. 翻译（失败直接抛异常，不静默吞掉）
        target_language = data.get("target_language", "zh")
        api_key = data.get("api_key", "")
        model_name = data.get("model_name", "")
        custom_base_url = data.get("custom_base_url", "")

        translated_texts = translate_text_list(
            original_texts,
            target_language=target_language,
            model_provider=model_provider,
            api_key=api_key,
            model_name=model_name,
            custom_base_url=custom_base_url,
        )

        # 6. 构建 BubbleState
        bubble_states = []
        for i, coord in enumerate(coords):
            fg = colors[i].get("fg_color") if i < len(colors) else None
            bg = colors[i].get("bg_color") if i < len(colors) else None
            bubble_states.append(BubbleState(
                original_text=original_texts[i] if i < len(original_texts) else "",
                translated_text=translated_texts[i] if i < len(translated_texts) else "",
                coords=tuple(coord),
                polygon=polygons[i] if i < len(polygons) else [],
                text_color=_rgb_to_hex(fg) or constants.DEFAULT_TEXT_COLOR,
                fill_color=_rgb_to_hex(bg) or constants.DEFAULT_FILL_COLOR,
                auto_fg_color=fg,
                auto_bg_color=bg,
            ))

        # 7. 修复（擦除原文）
        clean_pil, _ = inpaint_bubbles(
            img_pil, coords,
            method="solid",
            bubble_polygons=polygons,
            precise_mask=raw_mask,
        )

        # 8. 渲染（写入译文）
        final_pil = render_bubbles_unified(clean_pil, bubble_states)
        final_b64 = _encode_image_to_base64(np.array(final_pil))

        return jsonify({
            "success": True,
            "translated_image": f"data:image/jpeg;base64,{final_b64}",
            "original_texts": original_texts,
            "translated_texts": translated_texts,
            "bubble_count": len(coords),
            "warning": None,
        })

    except Exception as exc:
        logger.error("chrome translate-image 异常", exc_info=True)
        return jsonify({"success": False, "error": str(exc)}), 500
