#!/usr/bin/env node
import { createRequire } from 'node:module'
import { basename, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const COS = require('cos-nodejs-sdk-v5')
const [fileArg, keyArg] = process.argv.slice(2)
if (!fileArg || !keyArg) {
  console.error('usage: node publish-cos.mjs <file> <key>')
  process.exit(1)
}
if (!process.env.COS_SECRET_ID || !process.env.COS_SECRET_KEY) {
  console.log('COS secrets missing; skip upload')
  process.exit(0)
}
const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
  FileParallelLimit: 8,
  ChunkParallelLimit: 8,
  ChunkSize: 8 * 1024 * 1024,
})
const file = resolve(fileArg)
cos.uploadFile({
  Bucket: process.env.COS_BUCKET || 'botcamp-1307257815',
  Region: process.env.COS_REGION || 'ap-guangzhou',
  Key: keyArg,
  FilePath: file,
  SliceSize: 8 * 1024 * 1024,
}, (error, data) => {
  if (error) { console.error(error); process.exit(1) }
  console.log(`uploaded ${basename(file)} -> ${keyArg}`, data?.ETag ?? '')
})
