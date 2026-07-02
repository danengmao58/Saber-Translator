#!/bin/bash
# Saber Translator - Start all services for Chrome extension
echo "=== Starting Saber Translator Services ==="

# Kill existing processes
pkill -f ollama 2>/dev/null
pkill -f "python.*app.py" 2>/dev/null
sleep 1

# Start Ollama (CPU + Metal)
echo "[1/2] Starting Ollama..."
OLLAMA_LLM_LIBRARY=cpu /Applications/Ollama.app/Contents/Resources/ollama serve &>/tmp/ollama.log &
sleep 2

# Start Saber Translator backend
echo "[2/2] Starting Saber Translator backend..."
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" && .venv/bin/python app.py &>/tmp/saber.log &
sleep 8

# Verify
if curl -s http://127.0.0.1:11434/api/version > /dev/null; then
    echo "✅ Ollama running on :11434"
else
    echo "❌ Ollama failed to start"
fi

if curl -s http://127.0.0.1:5001/api/get_settings | grep -q success; then
    echo "✅ Saber Translator running on :5001"
else
    echo "❌ Saber Translator failed to start"
fi

echo ""
echo "=== Ready! ==="
echo "Chrome: open https://616pic.com/sucai/vj9inj48n.html"
echo "Right-click the image → 翻译图片为中文"
