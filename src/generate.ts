import {MediaTypeObject, OperationObject, ParameterObject, ResponseObject} from './openapitypes';
import {promises as fs} from 'fs';
import {OpenAPIV3, OpenAPIV3_1} from 'openapi-types';
import RequestBodyObject = OpenAPIV3_1.RequestBodyObject;

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

const parseSchemaObject = (schema: any): string => {
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

            if (
                (!schema.properties || Object.keys(schema.properties).length === 0)
                && (!schema.additionalProperties)
            ) {
                return 'any';
            }

            let content = '{\n';
            for (const propName in schema.properties) {
                const property = schema.properties[propName];
                const required = schema.required && schema.required.includes(propName);
                content += `  '${propName}'${required ? '' : '?'}: ${parseSchemaObject(
                    property,
                )};\n`;
            }
            content += '}';
            if (schema.additionalProperties) {
                content += '& Record<string, ';
                content += parseSchemaObject(schema.additionalProperties);
                content += '>';
            }
            return content;
        case 'string':
            if (schema.enum) {
                return schema.enum.map((e) => `'${e}'`).join(' | ');
            }
            if (schema.format === 'binary') {
                return 'stream.Readable';
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

    return 'any';
};

let chunks = [];
process.stdin.on('readable', () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) {
        chunks.push(chunk);
    }
});

process.stdin.on('end', async () => {

    const defaultContentType = 'application/json';
    const spec = JSON.parse(chunks.join('')) as OpenAPIV3.Document;
    const apis: Record<string, Action[]> = {};

    const paths = Object.keys(spec.paths);
    paths.forEach((path) => {
        const pathObject = spec.paths[path];
        ['get', 'post', 'delete', 'patch', 'put'].forEach((method) => {
            if (pathObject[method]) {
                const operation: OperationObject = pathObject[method];
                const apiName = getApiName(operation);


                operation.parameters ||= [];
                if (pathObject.parameters) {
                    operation.parameters = pathObject.parameters.concat(operation.parameters);
                }
                apis[apiName] ||= [];
                apis[apiName].push({
                    path,
                    method,
                    operation,
                });
            }
        });
    });

    let content = ``;

    content +=
        (await fs.readFile(__dirname + '/core-files.ts')).toString() + '\n\n';

    if (spec.components.schemas) {
        const schemas = spec.components.schemas;

        const schemasKeys = Object.keys(schemas);

        schemasKeys.map(async (schemasKey) => {
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

            // gather content types
            const mediaTypes = new Set();
            if (action.operation.requestBody) {
                for (const contentType in (action.operation.requestBody as RequestBodyObject).content) {
                    mediaTypes.add(contentType);
                }
            }
            if (action.operation.responses) {
                for (const statusCode in action.operation.responses) {
                    for (const contentType in (action.operation.responses[statusCode] as ResponseObject).content) {
                        mediaTypes.add(contentType);
                    }
                }
            }
            mediaTypes.delete('*/*');
            if (mediaTypes.size === 0) {
                mediaTypes.add(defaultContentType);
            }

            const generateAction = (action, apiMediaType) => {
                let content = '';
                let requestBodyContentMediaType;
                let requestBodyData: any;
                if (action.operation.requestBody) {
                    requestBodyData = action.operation.requestBody;
                    requestBodyContentMediaType =
                        requestBodyData.content[apiMediaType] ||
                        requestBodyData.content['*/*'];
                }

                let responseMediaType: boolean | MediaTypeObject = false;
                for (const statusCode in action.operation.responses) {
                    if (statusCode === 'default') {
                        responseMediaType = true;
                    }
                    if (parseInt(statusCode) >= 200 && parseInt(statusCode) < 300) {
                        const response = action.operation.responses[statusCode];
                        if (response.content) {
                            responseMediaType = response.content[apiMediaType] || response.content['*/*'];
                        }
                    }
                }
                if (!responseMediaType && !requestBodyContentMediaType) {
                    // return;
                }

                // function name
                content += `  async ${getOperationName(
                    action.operation.operationId +
                    '-' +
                    (apiMediaType === defaultContentType
                        ? ''
                        : apiMediaType.split('/')[1]),
                )}(`;

                const generateRequestBodyParam = () => {
                    if (requestBodyContentMediaType) {
                        let requestBodyType = parseSchemaObject(requestBodyContentMediaType.schema);
                        if (apiMediaType === 'multipart/form-data') {
                            requestBodyType += ' | FormData';
                        }
                        content += 'requestBody'
                        if (!requestBodyData.required) {
                            content += '?';
                        }
                        content += `: ${requestBodyType},`;
                    }
                };

                if (requestBodyData && requestBodyData.required) {
                    generateRequestBodyParam();
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
                    generateRequestBodyParam();
                }

                content += `)`;

                // return type
                const returnTypes = [];
                for (const statusCode in action.operation.responses) {
                    if (parseInt(statusCode) >= 200 && parseInt(statusCode) < 300) {
                        const response = action.operation.responses[statusCode];
                        if (responseMediaType !== true && responseMediaType !== false) {
                            returnTypes.push(
                                parseSchemaObject((responseMediaType as MediaTypeObject)?.schema || {}),
                            );
                        }
                    }
                }
                content +=
                    ':Promise<' +
                    (returnTypes.length > 0
                        ? returnTypes.join(' | ')
                        : 'stream.Readable') +
                    '>';
                content += ` {`;

                // parameters, method, path mapping
                content += `const _apiRequest:ApiRequest = {
                pathname: '${action.path}',
                searchParams: new URLSearchParams(),
                method: '${action.method}',
            };\n`;
                content += `_apiRequest.headers = {};\n`;

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

                if (requestBodyContentMediaType) {
                    content += `_apiRequest.headers['Content-type'] = '${apiMediaType}';\n`;
                    switch (apiMediaType) {
                        case 'multipart/form-data':
                            content += `_apiRequest.body = requestBody as FormData;\n`;
                            break;
                        case 'application/json':
                        default:
                            if (requestBodyContentMediaType.schema.type !== 'string') {
                                content += `_apiRequest.body = JSON.stringify(requestBody);\n`;
                            } else {
                                content += `_apiRequest.body = requestBody;\n`;
                            }
                            break;
                    }
                }

                if (returnTypes.length > 0) {
                    content += `_apiRequest.headers['Accept'] = '${apiMediaType}';\n`;
                }
                content += `return await this.client.fetch(_apiRequest, async (response) => {\n`;

                // response mapping and handling
                content += `switch (response.status) {`;
                for (const statusCodeString in action.operation.responses) {
                    const statusCode = parseInt(statusCodeString);
                    if (statusCode > 0) {
                        const response = action.operation.responses[statusCodeString];
                        content += `case ${statusCode}:\n`;
                        if (statusCode < 400) {
                            if (returnTypes.length > 0 && returnTypes[0] === 'stream.Readable') {
                                content += `return response.body;`;
                            } else if (response.content && response.content[apiMediaType] && returnTypes.length > 0) {
                                content += `return await this.client.jsonResponseHandler(_apiRequest, await response.json());`;
                            } else {
                                content += `return response.text();`;
                            }
                        } else {
                            content += 'throw new ApiRequestError(_apiRequest, response);';
                        }
                    }
                }

                content += `default:\n`;
                content += `if (response.status < 400) {
                      return response.body;
                    }
                    `;
                content += `throw new ApiRequestError(_apiRequest, response);`;
                content += `}\n`;
                content += `});\n`;
                content += `}\n\n`;
                return content;
            };

            mediaTypes.forEach(contentType => {
                const actionContent = generateAction(action, contentType)
                content += actionContent;
                if (!actionContent) {
                    console.error(`${action.method} ${action.path} ignored`);
                }
            });
        });

        content += `}\n\n`;
    }

    content += '';

    process.stdout.write(content);


});
