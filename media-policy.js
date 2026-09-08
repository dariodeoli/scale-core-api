import sharp from 'sharp';

const invalid = message => { throw Object.assign(new Error(message), {status:400}); };

// Links are stored verbatim; the server never downloads the linked document.
export function externalLink(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) invalid('Pegá un enlace HTTPS de archivo o carpeta');
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url;
  try { url = new URL(trimmed); } catch { invalid('Pegá un enlace HTTPS válido'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) invalid('El enlace debe usar HTTPS y no incluir credenciales');
  return trimmed;
}

// Only small, decoded raster profile pictures may be stored locally.
export async function profilePhoto(value) {
  if (!value || (typeof value === 'string' && !value.startsWith('data:'))) return externalLink(value);
  if (typeof value !== 'string' || value.length > 700000) invalid('La foto comprimida supera el límite permitido');
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) invalid('Usá una foto JPG, PNG o WebP');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 512 * 1024 || bytes.toString('base64') !== match[2]) invalid('Foto inválida o demasiado grande');
  // Reject SVG/document content before sending it to the decoder.
  const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (!({png,jpeg,webp})[match[1]]) invalid('El contenido no corresponde al formato de la foto');
  try {
    const image = sharp(bytes, {limitInputPixels:16000000, failOn:'warning'});
    const meta = await image.metadata();
    if ((meta.pages || 1) !== 1) invalid('Usá una foto sin animación');
    const output = await image.rotate().resize(256,256,{fit:'cover',withoutEnlargement:true}).webp({quality:80}).toBuffer();
    if (output.length > 90 * 1024) invalid('La foto es demasiado compleja; elegí otra imagen');
    return `data:image/webp;base64,${output.toString('base64')}`;
  } catch (error) {
    if (error.status) throw error;
    invalid('No se pudo leer la foto. Usá un JPG, PNG o WebP válido');
  }
}
