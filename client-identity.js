import {profilePhoto} from './media-policy.js';
export const clientColors=['violet','blue','teal','green','gold','rose','slate'];
export function clientColor(value='violet'){
 if(!clientColors.includes(value))throw Object.assign(new Error('Elegí un color de la paleta'),{status:400});
 return value;
}
export async function clientLogo(value){
 if(value && (typeof value!=='string'||!value.startsWith('data:image/')))throw Object.assign(new Error('Subí una imagen JPG, PNG o WebP para el logo'),{status:400});
 return profilePhoto(value,{fit:'contain'});
}
