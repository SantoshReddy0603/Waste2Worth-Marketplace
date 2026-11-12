# Container for Hugging Face Spaces (or any Docker host). Listens on 7860, the Spaces default.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production PORT=7860 TRUST_PROXY=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

# Spaces run as uid 1000, which is the image's built-in `node` user.
USER node
EXPOSE 7860
CMD ["node", "server.mjs"]
