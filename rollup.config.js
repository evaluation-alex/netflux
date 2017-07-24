import filesize from 'rollup-plugin-filesize'
import babel from 'rollup-plugin-babel'
import strip from 'rollup-plugin-strip'
import commonjs from 'rollup-plugin-commonjs'
import resolve from 'rollup-plugin-node-resolve'
import typescript from 'rollup-plugin-typescript2'
import pkg from './package.json'

export default [
  {
    entry: 'src/index.js',
    targets: [
      { dest: pkg.main, format: 'cjs' },
      { dest: pkg.module, format: 'es' }
    ],
    external: ['wrtc', 'uws', 'text-encoding'],
    plugins: [
      typescript(),
      strip({
        functions: [ 'console.info' ]
      }),
      resolve(),
      commonjs({
        namedExports: {
          'node_modules/protobufjs/minimal.js': [ 'Reader', 'Writer', 'util', 'roots' ]
        }
      }),
      babel({
        exclude: 'node_modules/**'
      }),
      filesize({ format: { round: 0 } })
    ]
  },
  {
    entry: 'src/index.js',
    format: 'umd',
    moduleName: 'netflux',
    dest: pkg.browser,
    plugins: [
      typescript(),
      strip({
        functions: [ 'console.info' ]
      }),
      resolve(),
      commonjs({
        namedExports: {
          'node_modules/protobufjs/minimal.js': [ 'Reader', 'Writer', 'util', 'roots' ]
        }
      }),
      babel({
        exclude: 'node_modules/**'
      }),
      filesize({ format: { round: 0 } })
    ]
  }
]
