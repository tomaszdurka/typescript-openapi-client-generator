FROM node:20-slim as builder

WORKDIR /app
COPY yarn.lock .
COPY package.json .
RUN yarn install
COPY . .


FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package.json
ENTRYPOINT ["yarn", "--silent", "generate"]
CMD [""]
