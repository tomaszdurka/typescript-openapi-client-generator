# Typescript OpenApi Client Generator

Library to create typescript client for openapi specification.

## Usage

Local
```
cat '<open-api-spec.json>' | docker run --rm -i ghcr.io/tomaszdurka/ts-openapi-client-generator > '<TypescriptApi.ts>'
```

Straight from online spec
```
curl --silent '<https://open-api-spec.json>' | docker run --rm -i ghcr.io/tomaszdurka/ts-openapi-client-generator > '<TypescriptApi.ts>'
```
