FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu
RUN pip --default-timeout=1000 install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "api_server.py"]
