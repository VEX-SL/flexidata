FROM python:3.10-slim

WORKDIR /app

# تثبيت المكتبات النظامية الضرورية لـ OpenCV و PaddleOCR
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# نسخ ملف المتطلبات وتثبيتها
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# نسخ باقي ملفات تطبيق الـ OCR
COPY . .

EXPOSE 8000

# تشغيل خادم FastAPI
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]