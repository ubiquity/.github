import { resolve as _resolve, dirname } from 'path'

export const entry = './src/index.ts'
export const output = {
    filename: 'bundle.js',
    path: _resolve(dirname(process.cwd), 'dist'),
}
export const resolve = {
    extensions: ['.ts', '.js'],
}
export const module = {
    rules: [
        {
            test: /\.ts$/,
            use: 'ts-loader',
            exclude: /node_modules/,
        },
    ],
}
