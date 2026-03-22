import requests
import logging

logger = logging.getLogger(__name__)


class DeepLTranslateInterface:
    """DeepL 翻译 API 封装"""

    API_URL = 'https://api-free.deepl.com/v2/translate'

    def __init__(self, api_key: str = None):
        self.api_key = api_key

    def set_credentials(self, api_key: str):
        self.api_key = api_key

    def translate(self, text: str, target_lang: str = 'ZH', source_lang: str = 'auto', max_retries: int = 2, retry_delay: float = 1.0) -> str:
        if not self.api_key:
            raise ValueError('DeepL API未配置 auth_key')

        if not text or not text.strip():
            return ''

        headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': f'DeepL-Auth-Key {self.api_key}'
        }

        data = {
            'text': text,
            'target_lang': target_lang,
            # DeepL auto-detect source_lang 时请不要传 auto，直接不传或传空
        }

        if source_lang and source_lang.lower() != 'auto':
            data['source_lang'] = source_lang

        for attempt in range(max_retries):
            try:
                response = requests.post(self.API_URL, headers=headers, data=data, timeout=20)
                response.raise_for_status()
                body = response.json()
                if 'translations' in body and body['translations']:
                    return body['translations'][0].get('text', '').strip()
                raise ValueError(f"DeepL返回格式异常: {body}")
            except requests.exceptions.RequestException as e:
                logger.warning(f"DeepL翻译请求异常 (attempt {attempt + 1}/{max_retries}): {e}")
                if attempt < max_retries - 1:
                    import time
                    time.sleep(retry_delay)
                    continue
                raise

        raise Exception('DeepL翻译失败，达到最大重试次数')

    def test_connection(self) -> tuple:
        if not self.api_key:
            return False, '未配置 DeepL API Key'

        try:
            translated = self.translate('Hello world', target_lang='ZH')
            if translated:
                return True, f'DeepL 连接成功，测试翻译：{translated}'
            return False, 'DeepL 连接成功，但测试翻译返回为空'
        except Exception as e:
            return False, f'DeepL 连接失败: {str(e)}'


deepl_translate = DeepLTranslateInterface()