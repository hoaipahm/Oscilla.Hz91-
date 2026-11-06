'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {byteRange,mediaResponse} = require('../media.cjs');
test('HTTP byte ranges support regular, open, suffix and reject invalid ranges',() => {
  assert.deepEqual(byteRange('bytes=10-20',100),{start:10,end:20,status:206});
  assert.deepEqual(byteRange('bytes=50-',100),{start:50,end:99,status:206});
  assert.deepEqual(byteRange('bytes=-10',100),{start:90,end:99,status:206});
  assert.deepEqual(byteRange('bytes=0-999',100),{start:0,end:99,status:206});
  for (const header of ['bytes=200-','bytes=10-1','bytes=0-1,3-4','bytes=-0','anything','bytes=-']) assert.equal(byteRange(header,100),null);
});
test('media responses stream exactly requested bytes with truthful length and MIME',async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),'green-media-'));
  try {
    const file = path.join(folder,'clip.mp3'); await fs.writeFile(file,'0123456789');
    const response = await mediaResponse(new Request('https://local/',{headers:{range:'bytes=3-5'}}),file);
    assert.equal(response.status,206); assert.equal(response.headers.get('content-range'),'bytes 3-5/10');
    assert.equal(response.headers.get('content-length'),'3'); assert.equal(response.headers.get('content-type'),'audio/mpeg');
    assert.equal(await response.text(),'345');
    const head = await mediaResponse(new Request('https://local/',{method:'HEAD'}),file);
    assert.equal(head.headers.get('content-length'),'10'); assert.equal(await head.text(),'');
    assert.equal((await mediaResponse(new Request('https://local/',{headers:{range:'bytes=99-'}}),file)).status,416);
    assert.equal((await mediaResponse(new Request('https://local/'),file + '-missing')).status,404);
  } finally { await fs.rm(folder,{recursive:true,force:true}); }
});
