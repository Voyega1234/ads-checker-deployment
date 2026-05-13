FROM mcr.microsoft.com/playwright:v1.51.1-noble

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY v2.0_run-all-ad-acc/requirements.txt ./v2.0_run-all-ad-acc/requirements.txt
RUN python3 -m pip install --no-cache-dir -r ./v2.0_run-all-ad-acc/requirements.txt

COPY . .

ENTRYPOINT ["python3", "production/worker/main.py"]
