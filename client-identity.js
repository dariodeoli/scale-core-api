import {profilePhoto} from './media-policy.js';
export const clientColors=['violet','blue','teal','green','gold','rose','slate'];
export function clientColor(value='violet'){
 if(!clientColors.includes(value))throw Object.assign(new Error('Elegí un color de la paleta'),{status:400});
 return value;
}
export async function clientLogo(value){
 // Optional external HTTPS image links are stored, never fetched by the API.
 return profilePhoto(value,{fit:'contain'});
}
