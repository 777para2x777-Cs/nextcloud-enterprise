FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y gcc libssl-dev && rm -rf /var/lib/apt/lists/*
COPY app/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ .
COPY rules/ /app/rules/
RUN chmod +x /app/start.sh
EXPOSE 8000 3311
CMD ["/app/start.sh"]
