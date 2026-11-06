'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const path = require('node:path');
const TYPES = {'.mp3':'audio/mpeg','.wav':'audio/wav','.flac':'audio/flac','.ogg':'audio/ogg','.opus':'audio/ogg','.m4a':'audio/mp4','.aac':'audio/aac','.webm':'audio/webm',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.avif':'image/avif'};
function byteRange(header,size) {
  if (!header) return {start:0,end:size - 1,status:200};
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0,size - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(size - 1,Number(match[2])) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return {start,end,status:206};
}
async function mediaResponse(request,filename) {
  if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405});
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile()) return new Response(null,{status:404});
    const range = byteRange(request.headers.get('range'),stat.size);
    if (!range) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${stat.size}`}});
    const headers = {'Content-Type':TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges':'bytes','Content-Length':String(range.end - range.start + 1),'Cache-Control':'no-store','Access-Control-Allow-Origin':'green://app'};
    if (range.status === 206) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    const body = request.method === 'HEAD' || stat.size === 0 ? null : Readable.toWeb(createReadStream(filename,{start:range.start,end:range.end}));
    return new Response(body,{status:range.status,headers});
  } catch { return new Response(null,{status:404}); }
}
module.exports = {byteRange,mediaResponse};
