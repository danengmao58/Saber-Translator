import requests
resp = requests.post(
    "https://api-free.deepl.com/v2/translate",
    headers={"Authorization": "DeepL-Auth-Key a9d909fb-0906-4f11-aacc-e0971afe4195:fx"},
    data={"text": "Hello world", "target_lang": "ZH"},
    timeout=20,
)
print(resp.status_code)
print(resp.json())