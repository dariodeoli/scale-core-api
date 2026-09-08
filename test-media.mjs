import assert from 'node:assert/strict';
import sharp from 'sharp';
import {externalLink,profilePhoto} from './media-policy.js';

for(const url of ['https://drive.google.com/file/d/demo/view?usp=sharing','https://drive.google.com/drive/folders/demo?resourcekey=abc','https://docs.google.com/document/d/demo/edit'])assert.equal(externalLink(` ${url} `),url);
for(const bad of ['javascript:alert(1)','data:application/pdf;base64,YQ==','file:///tmp/file','http://drive.google.com/a','https://user:secret@example.com/',{},'https://example.com/'+ 'a'.repeat(2048)])assert.throws(()=>externalLink(bad),{status:400});
assert.equal(externalLink(''),null);
const png=await sharp({create:{width:512,height:400,channels:3,background:{r:120,g:30,b:140}}}).png().toBuffer();
const data='data:image/png;base64,'+png.toString('base64');
const photo=await profilePhoto(data);
assert.ok(photo.startsWith('data:image/webp;base64,'));
const metadata=await sharp(Buffer.from(photo.split(',')[1],'base64')).metadata();
assert.equal(metadata.width,256);assert.equal(metadata.height,256);assert.equal(metadata.exif,undefined);
assert.equal(await profilePhoto(null),null);
assert.equal(await profilePhoto('https://example.com/profile.jpg'),'https://example.com/profile.jpg');
for(const bad of ['data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,PHN2Zy8+','data:application/pdf;base64,JVBERg==','data:image/jpeg;base64,'+png.toString('base64'),'data:image/png;base64,'+'a'.repeat(700000)])await assert.rejects(()=>profilePhoto(bad),{status:400});
const huge=await sharp({create:{width:4096,height:4097,channels:3,background:{r:0,g:0,b:0}}}).png().toBuffer();
await assert.rejects(()=>profilePhoto('data:image/png;base64,'+huge.toString('base64')),{status:400});
console.log('PASS: file/folder HTTPS links remain external; profile pictures decoded, resized, stripped; documents/SVG/oversize rejected');
