import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
function crc32(buf){let c=0xffffffff;for(const byte of buf){c^=byte;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([len,type,data,crc]);}
function icon(size){const rows=Buffer.alloc((size*4+1)*size),scale=size/512;for(let y=0;y<size;y++){let row=y*(size*4+1);rows[row]=0;for(let x=0;x<size;x++){const px=(x+.5)/scale,py=(y+.5)/scale,dx=px-256,dy=py-256,ax=Math.abs(dx),ay=Math.abs(dy);const rounded=(ax<=184&&ay<=184)||(ax<=196&&ay<=172)||(ax<=172&&ay<=196);const radius=Math.hypot(dx,dy),angle=Math.atan2(dy,dx),starRadius=76+55*Math.abs(Math.cos(angle*4));const dark=rounded&&radius<starRadius&&radius>34;const i=row+1+x*4;rows[i]=dark?23:183;rows[i+1]=dark?32:243;rows[i+2]=dark?15:107;rows[i+3]=rounded?255:0;}}const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;const data=zlib.deflateSync(rows);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',data),chunk('IEND',Buffer.alloc(0))]);}
for(const size of [192,512])fs.writeFileSync(path.join(root,`icon-${size}.png`),icon(size));
