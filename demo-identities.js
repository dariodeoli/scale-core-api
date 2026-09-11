import {readFileSync} from 'node:fs';

// Reserved .example addresses and a deliberately non-operational telephone prefix.
// These are display fixtures, never credentials, actual businesses or contact destinations.
export const demoPhone=index=>`+595 000 421 ${String(100+index).padStart(3,'0')}`;
export const demoStaff=[
 ['Lucía Acosta','lucia.acosta','lucia'],['Mateo Ríos','mateo.rios','mateo'],
 ['Camila Vera','camila.vera','camila'],['Nicolás Duarte','nicolas.duarte','nicolas'],
 ['Valentina Sol','valentina.sol','valentina'],
];
const portraits=new Map();
export function demoPortrait(key){
 if(!['lucia','mateo','camila','nicolas','valentina','sebastian'].includes(key))throw Error('Retrato de demo desconocido');
 if(!portraits.has(key))portraits.set(key,'data:image/webp;base64,'+readFileSync(new URL(`./assets/demo/${key}.webp`,import.meta.url)).toString('base64'));
 return portraits.get(key);
}

const companies=[
 ['Aurora Café','auroracafe','hola','#713F33','<path d="M70 98h100v38a42 42 0 0 1-84 0V98m84 4h12a20 20 0 0 1 0 40h-12M72 184h116M108 62v16m28-16v16"/>'],
 ['Bosque Hogar','bosquehogar','contacto','#27634B','<path d="M58 128l70-64 70 64M78 112v78h100v-78M113 190v-49h30v49"/>'],
 ['Órbita Fitness','orbitafitness','reservas','#146F75','<ellipse cx="128" cy="128" rx="78" ry="35" transform="rotate(-35 128 128)"/><circle cx="128" cy="128" r="22" fill="currentColor" stroke="none"/>'],
 ['Nube Software','nubesoftware','equipo','#4262AE','<path d="M80 168a30 30 0 0 1-4-60 49 49 0 0 1 95-8 34 34 0 0 1 8 68H80m20-37 15-15m-15 15 15 15m41-30 15 15-15 15"/>'],
 ['Luna Moda','lunamoda','hola','#75527A','<path d="M165 64a67 67 0 1 0 28 110A69 69 0 0 1 165 64Z"/><circle cx="189" cy="86" r="6" fill="currentColor"/>'],
 ['Brisa Viajes','brisaviajes','reservas','#267C97','<path d="m62 134 132-65-53 131-19-58-60-8Zm60 8 72-73M62 190h38"/>'],
 ['Prisma Diseño','prismadiseno','estudio','#8B437B','<path d="m128 59 78 135H50L128 59Zm0 0v135m-78 0 78-47 78 47"/>'],
 ['Raíz Orgánica','raizorganica','pedidos','#55733C','<path d="M127 189v-62m0 9C66 146 67 85 65 67c52 1 69 25 62 69Zm0 13c62 0 66-45 67-67-51 2-70 29-67 67Zm0 40-29 16m29-16 29 16"/>'],
 ['Faro Inmuebles','faroinmuebles','ventas','#425B7B','<path d="m103 103-14 95h78l-14-95h-50Zm0 0V76h50v27m-54-27 29-22 29 22M72 198h112M107 137h42m-47 34h51M63 89H45m148 0h18"/>'],
 ['Menta Salud','mentasalud','turnos','#318877','<path d="M112 63h32v49h49v32h-49v49h-32v-49H63v-32h49V63Z"/>'],
 ['Sur Automotores','surautomotores','ventas','#B3543D','<path d="m65 130 18-45h90l18 45M58 130h140v48H58v-48Zm16 48v18m108-18v18M82 151h12m68 0h12"/>'],
 ['Pixel Academy','pixelacademy','admisiones','#6A56A5','<path d="m48 112 80-40 80 40-80 40-80-40Zm32 18v42q48 29 96 0v-42m32-18v69"/>'],
 ['Alma Cocina','almacocina','reservas','#A15336','<path d="M81 66v55m20-55v55m20-55v55m-40 0q20 24 40 0m-20 15v61m66-131c-26 0-26 73 0 73V66Zm0 73v58"/>'],
 ['Ruta Outdoor','rutaoutdoor','hola','#5C7048','<path d="m48 187 62-105 32 49 20-31 46 87H48Zm39-66 23 14 19-14m-7 66 22-29-14-15"/>'],
 ['Nova Energía','novaenergia','comercial','#A97614','<path d="m146 51-75 99h52l-9 55 73-102h-52l11-52Z"/>'],
 ['Marea Cosmética','mareacosmetica','hola','#B85F77','<path d="M128 58c-18 28-51 59-51 91a51 51 0 0 0 102 0c0-32-33-63-51-91Zm-48 93q25-24 49 0t49 0"/>'],
 ['Roble Muebles','roblemuebles','ventas','#80634C','<path d="M86 65h84v81H86V65Zm-18 82h120v25H68v-25Zm11 25v27m98-27v27M106 82v45m43-45v45"/>'],
 ['Cumbre Seguros','cumbreseguros','asesoria','#3E607A','<path d="m128 53 65 26v55c0 33-40 59-65 70-25-11-65-37-65-70V79l65-26Zm-33 74 24 24 43-50"/>'],
 ['Punto Libros','puntolibros','pedidos','#A45449','<path d="M128 91q-30-26-72-17v109q42-9 72 17 30-26 72-17V74q-42-9-72 17Zm0 0v109M77 105l29 7m-29 21 29 7m45-28 28-7"/>'],
 ['Sol Pet','solpet','turnos','#BA7934','<ellipse cx="128" cy="158" rx="43" ry="34"/><ellipse cx="73" cy="118" rx="14" ry="20"/><ellipse cx="107" cy="85" rx="14" ry="20"/><ellipse cx="149" cy="85" rx="14" ry="20"/><ellipse cx="183" cy="118" rx="14" ry="20"/>'],
];
export const demoClients=companies.map(([name,slug,mail,color,symbol],index)=>({
 name,email:`${mail}@${slug}.example`,phone:demoPhone(index+10),
 logo:'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="${color}"/><g fill="none" stroke="#fff" color="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">${symbol}</g></svg>`).toString('base64'),
}));
