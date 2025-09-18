# Naudojame oficialų Node.js 20 atvaizdą
FROM node:20-slim

# Įdiegiame FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Nustatome darbinį katalogą
WORKDIR /usr/src/app

# Nukopijuojame package.json ir package-lock.json
COPY package*.json ./

# Įdiegiame priklausomybes
RUN npm install

# Nukopijuojame likusį aplikacijos kodą
COPY . .

# Nurodome, kad aplikacija veiks per 10000 portą (Render naudos šį)
EXPOSE 10000

# Komanda, kuri bus paleista paleidus konteinerį
CMD [ "node", "index.js" ]
