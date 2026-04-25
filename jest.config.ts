import type { Config } from 'jest';

const config: Config = {
    moduleFileExtensions: [ 'js', 'json', 'ts' ],
    rootDir: 'src',
    testRegex: '.*\\.spec\\.ts$',
    transform: {
        '^.+\\.(t|j)s$': [ 'ts-jest', {
            tsconfig: '<rootDir>/../tsconfig.json',
            diagnostics: false,
        } ],
    },
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
        '^@generated/(.*)$': '<rootDir>/../generated/$1',
        // uuid v14+는 ESM 전용 → CJS 스텁으로 대체
        '^uuid$': '<rootDir>/__mocks__/uuid.js',
    },
    testEnvironment: 'node',
};

export default config;
