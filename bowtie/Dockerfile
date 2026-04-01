FROM node:22-bookworm
RUN apt-get update && apt-get install -y libre2-dev libabsl-dev libmimalloc-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/app
RUN npm init -y && npm install ata-validator
COPY bowtie_ata.js .
CMD ["node", "bowtie_ata.js"]
