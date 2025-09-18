# Naudojame oficialų Node.js 18 atvaizdą
FROM node:18-slim

# Įdiegiame FFMPEG ir kitus reikalingus paketus
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Nustatome darbo direktoriją konteinerio viduje
WORKDIR /usr/src/app

# Kopijuojame package.json ir package-lock.json
COPY package*.json ./

# Įdiegiame projekto priklausomybes
RUN npm install

# Kopijuojame likusį aplikacijos kodą
COPY . .

# Nurodome, kad aplikacija naudos 10000 portą
EXPOSE 10000

# Komanda, kuri bus paleista konteineriui startavus
CMD [ "npm", "start" ]
