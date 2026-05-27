import { OpenAPIObject } from '@nestjs/swagger';

const defaultJsonSchema = {
  type: 'object',
  additionalProperties: true,
  example: {
    message: 'JSON response',
  },
};

export function addDefaultResponseSchemas(document: OpenAPIObject): OpenAPIObject {
  for (const pathItem of Object.values(document.paths)) {
    for (const operation of Object.values(pathItem ?? {})) {
      if (!operation || typeof operation !== 'object' || !('responses' in operation)) continue;

      for (const [statusCode, response] of Object.entries(operation.responses ?? {})) {
        if (!/^2\d\d$/.test(statusCode)) continue;
        if (!response || typeof response !== 'object') continue;

        const mutableResponse = response as Record<string, any>;

        if (!mutableResponse.description) {
          mutableResponse.description = 'JSON response';
        }

        if (!('content' in mutableResponse)) {
          mutableResponse.content = {
            'application/json': {
              schema: defaultJsonSchema,
            },
          };
        }
      }
    }
  }

  return document;
}
