import { OperationObject, ParameterObject } from './openapitypes';
import { promises as fs } from 'fs';
import { OpenAPIV3 } from 'openapi-types';

const specPath = process.argv[2];

const lowercaseFirstLetter = (string) =>
  string.charAt(0).toLowerCase() + string.slice(1);

const strip = (string: string) =>
  string
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) => {
      return word.toUpperCase();
    })
    .replace(/[^a-z0-9_]+/gi, '');

const getApiName = (operation: OperationObject) =>
  strip(operation.tags[0]) + 'Api';

const getOperationName = (operationName: string) =>
  lowercaseFirstLetter(strip(operationName));

const getVariableName = (string) => lowercaseFirstLetter(strip(string));

const reservedKeywords = ['Response'];
const tokenMappings = {};
const getTokenName = (token: string) => {
  // Bla => Bla
  // Response => Response1
  token = strip(token);

  if (tokenMappings[token]) {
    return tokenMappings[token];
  }

  let value = token;
  let i = 0;
  while (reservedKeywords.includes(value)) {
    i++;
    value = token + '_' + String(i);
  }
  reservedKeywords.push(value);
  tokenMappings[token] = value;
  return value;
};

type Action = {
  path: string;
  method: string;
  operation: OperationObject;
};

const parseSchemaObject = (schema: any) => {
  if (schema.allOf && schema.allOf instanceof Array) {
    return schema.allOf
      .map((sub) => parseSchemaObject(sub))
      .filter((e) => e)
      .join(' & ');
  }
  if (schema.anyOf && schema.anyOf instanceof Array) {
    return schema.anyOf
      .map((sub) => parseSchemaObject(sub))
      .filter((e) => e)
      .join(' | ');
  }
  if (schema.oneOf && schema.oneOf instanceof Array) {
    return schema.oneOf
      .map((sub) => parseSchemaObject(sub))
      .filter((e) => e)
      .join(' | ');
  }

  if (schema.$ref) {
    return getTokenName(schema.$ref.split('/').slice(-1)[0]);
  }

  if (schema.type === undefined && schema.properties !== undefined) {
    schema.type = 'object';
  }

  switch (schema.type) {
    case 'object':
      let content = '{\n';
      for (const propName in schema.properties) {
        const property = schema.properties[propName];
        const required = schema.required && schema.required.includes(propName);
        content += `  '${propName}'${required ? '' : '?'}: ${parseSchemaObject(
          property,
        )};\n`;
      }
      content += '}';
      return content;
    case 'string':
      if (schema.enum) {
        return schema.enum.map((e) => `'${e}'`).join(' | ');
      }
      if (schema.format === 'binary') {
        return 'ReadableStream<Uint8Array>';
      }
      return 'string';
    case 'integer':
    case 'float':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return `Array<${parseSchemaObject(schema.items)}>`;
  }
};

(async () => {
  const mainApiMediaType = 'application/json';
  const additionalApiMediaTypes = ['application/octet-stream'];
  const file = (await fs.readFile(specPath)).toString();
  const json = JSON.parse(file);
  const spec: OpenAPIV3.Document = json;

  const apis: Record<string, Action[]> = {};

  const paths = Object.keys(spec.paths);
  paths.forEach((path) => {
    const pathObject = spec.paths[path];
    ['get', 'post', 'delete', 'patch', 'put'].forEach((method) => {
      if (pathObject[method]) {
        const operation: OperationObject = pathObject[method];
        const apiName = getApiName(operation);

        apis[apiName] ||= [];
        apis[apiName].push({
          path,
          method,
          operation,
        });
      }
    });
  });

  const packageName = strip(spec.info.title);
  let content = ``;

  content +=
    (await fs.readFile(__dirname + '/core-files.ts')).toString() + '\n\n';

  if (spec.components.schemas) {
    const schemas = spec.components.schemas;

    const schemasKeys = Object.keys(schemas);

    await schemasKeys.map(async (schemasKey) => {
      const schema: any = schemas[schemasKey];
      content += `export type ${getTokenName(schemasKey)} = ${parseSchemaObject(
        schema,
      )}\n\n`;
    });
  }

  for (const apiName in apis) {
    const api = apis[apiName];

    content += `export class ${apiName} {\n\n`;
    content += `constructor(private readonly client:Client) {}\n\n`;

    api.forEach((action: Action) => {
      const generateAction = (action, apiMediaType) => {
        let actionHasMediaType = false;

        let requestBodyData: any;
        if (action.operation.requestBody) {
          requestBodyData = action.operation.requestBody;
          if (requestBodyData.content[apiMediaType]) {
            actionHasMediaType = true;
          }
        }

        for (const statusCode in action.operation.responses) {
          if (parseInt(statusCode) >= 200 && parseInt(statusCode) < 300) {
            const response = action.operation.responses[statusCode];
            if (response.content && response.content[apiMediaType]) {
              actionHasMediaType = true;
            }
          }
        }
        if (!actionHasMediaType) {
          return;
        }

        // function name
        content += `  async ${getOperationName(
          action.operation.operationId +
            '-' +
            (apiMediaType === mainApiMediaType
              ? ''
              : apiMediaType.split('/')[1]),
        )}(`;
        const requestBodyContent = () => {
          if (requestBodyData.content[apiMediaType]) {
            content += `requestBody${
              requestBodyData.required ? '' : '?'
            }: ${parseSchemaObject(
              requestBodyData.content[apiMediaType].schema,
            )},`;
          }
        };

        if (requestBodyData && requestBodyData.required) {
          requestBodyContent();
        }

        // parameters
        if (action.operation.parameters) {
          action.operation.parameters
            .sort(
              (a: ParameterObject, b: ParameterObject) =>
                +(b.required !== undefined && b.required) -
                +(a.required !== undefined && a.required),
            )
            .forEach((parameter: ParameterObject) => {
              content += `${getVariableName(parameter.name)}${
                parameter.required ? '' : '?'
              }: ${parseSchemaObject(parameter.schema)},`;
            });
        }

        if (requestBodyData && !requestBodyData.required) {
          requestBodyContent();
        }

        content += `)`;

        // return type
        const returnTypes = [];
        for (const statusCode in action.operation.responses) {
          if (parseInt(statusCode) >= 200 && parseInt(statusCode) < 300) {
            const response = action.operation.responses[statusCode];
            if (response.content && response.content[apiMediaType]) {
              returnTypes.push(
                parseSchemaObject(response.content[apiMediaType].schema),
              );
            }
          }
        }
        content +=
          ':Promise<' +
          (returnTypes.length > 0 ? returnTypes.join(' | ') : 'Blob') +
          '>';
        content += ` {`;

        // parameters, method, path mapping
        content += `const _apiRequest:ApiRequest = {
                pathname: '${action.path}',
                searchParams: new URLSearchParams(),
                method: '${action.method}',
                headers: {},
            };\n`;

        if (action.operation.parameters) {
          action.operation.parameters.forEach((parameter: ParameterObject) => {
            if (!parameter.required) {
              content += `if (${getVariableName(
                parameter.name,
              )} !== undefined) {\n`;
            }
            if (parameter.in === 'path') {
              content += `_apiRequest.pathname = _apiRequest.pathname.replace('{${
                parameter.name
              }}', encodeURIComponent(String(${getVariableName(
                parameter.name,
              )})));\n`;
            }
            if (parameter.in === 'query') {
              content += `_apiRequest.searchParams.append('${
                parameter.name
              }', String(${getVariableName(parameter.name)}));\n`;
            }
            if (parameter.in === 'header') {
              content += `_apiRequest.headers['${
                parameter.name
              }'] = String(${getVariableName(parameter.name)});\n`;
            }
            if (!parameter.required) {
              content += `}\n`;
            }
          });
        }

        if (requestBodyData && requestBodyData.content[apiMediaType]) {
          content += `_apiRequest.headers['Content-type'] = '${apiMediaType}';\n`;
          if (requestBodyData.content[apiMediaType].schema.type !== 'string') {
            content += `_apiRequest.body = JSON.stringify(requestBody);\n`;
          } else {
            content += `_apiRequest.body = requestBody;\n`;
          }
        }

        if (returnTypes.length > 0) {
          content += `_apiRequest.headers['Accept'] = '${apiMediaType}';\n`;
        }
        content += `const response = await this.client.fetch(_apiRequest);\n`;

        // response mapping and handling

        content += `switch (response.status) {`;
        for (const statusCodeString in action.operation.responses) {
          const statusCode = parseInt(statusCodeString);
          if (statusCode > 0) {
            const response = action.operation.responses[statusCodeString];
            content += `case ${statusCode}:\n`;
            if (statusCode < 300) {
              content += `return`;
            } else {
              content += 'throw new ResponseError(response, ';
            }
            if (response.content && response.content[apiMediaType]) {
              content += ` await this.client.successJsonResponseParser(await response.json())`;
            } else {
              content += ` await response.blob()`;
            }
            if (statusCode < 300) {
              content += `;`;
            } else {
              content += ');';
            }
          }
        }

        content += `default:\n`;
        if (returnTypes.length === 0) {
          content += `if (response.status < 300) {
                        return await response.blob();
                    } else {
                    `;
        }
        content += `throw new ResponseError(response, await response.blob());`;
        if (returnTypes.length === 0) {
          content += `}`;
        }
        content += `}`;
        content += ` }\n\n`;
      };

      [mainApiMediaType]
        .concat(additionalApiMediaTypes)
        .forEach((apiMediaType) => {
          generateAction(action, apiMediaType);
        });
    });

    content += `}\n\n`;
  }

  content += '';

  await fs.mkdir(__dirname + `/../generated`, { recursive: true });
  await fs.writeFile(__dirname + `/../generated/${packageName}.ts`, content);
}).call(null);
