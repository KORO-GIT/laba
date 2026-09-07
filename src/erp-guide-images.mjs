import sharp from 'sharp';
import {fail} from './erp-database.mjs';

export const MAX_GUIDE_UPLOAD=6*1024*1024;
sharp.cache(false);
sharp.concurrency(1);
let processing=false;

export async function normalizeGuideImage(body) {
  if(processing)fail(429,'Інше фото ще обробляється. Спробуйте за кілька секунд');
  const input=Buffer.from(body.data,'base64');
  if(!input.length||input.length>MAX_GUIDE_UPLOAD||input.toString('base64')!==body.data)fail(400,'Некоректне фото або розмір понад 6 МБ');
  const format=input.subarray(0,3).equals(Buffer.from([255,216,255]))?'jpeg':input.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':input.toString('ascii',0,4)==='RIFF'&&input.toString('ascii',8,12)==='WEBP'?'webp':null;
  const extension=body.filename.split('.').at(-1).toLowerCase();
  if(!format||!(format==='jpeg'?['jpg','jpeg']: [format]).includes(extension))fail(400,'Потрібне справжнє JPG, PNG або WebP фото; SVG та інші файли не приймаються');
  processing=true;
  try {
    const image=sharp(input,{limitInputPixels:16000000,limitInputChannels:4,failOn:'warning',unlimited:false,animated:false});
    const metadata=await image.metadata();
    if(metadata.format!==format||(metadata.pages??1)>1)fail(400,'Анімації не підтримуються; виберіть звичайне фото');
    const result=await image.rotate().resize({width:2000,height:2000,fit:'inside',withoutEnlargement:true}).webp({quality:84,effort:3}).timeout({seconds:5}).toBuffer({resolveWithObject:true});
    if(result.data.length>2*1024*1024)fail(400,'Фото надто складне; зменште його розмір і спробуйте знову');
    return {data:result.data,width:result.info.width,height:result.info.height};
  } catch(error) {
    if(error.statusCode)throw error;
    fail(400,'Не вдалося прочитати фото. Використайте JPG, PNG або WebP до 6 МБ і 16 мегапікселів');
  } finally {processing=false;}
}
