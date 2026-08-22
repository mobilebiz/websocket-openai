# syntax = docker/dockerfile:1

# package.json の engines と揃えること
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

WORKDIR /app

ENV NODE_ENV="production"


# 依存のビルド専用ステージ（最終イメージには含めない）
FROM base AS build

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3 && \
    rm -rf /var/lib/apt/lists/*

# 依存だけ先に入れてレイヤーキャッシュを効かせる
COPY package-lock.json package.json ./
RUN npm ci --omit=dev

COPY . .


# 実行用イメージ
FROM base

COPY --from=build /app /app

EXPOSE 3000
CMD [ "npm", "run", "start" ]
