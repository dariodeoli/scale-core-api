// Only use the picture received from Google's verified userinfo response.
// No download, redirects, credentials or arbitrary external image hosts.
export function googleProfilePhoto(profile){
 if(profile?.email_verified!==true||typeof profile.picture!=='string'||profile.picture.length>2048)return null;
 try{
  const url=new URL(profile.picture);
  if(url.protocol!=='https:'||url.username||url.password||url.port||!url.hostname.endsWith('.googleusercontent.com'))return null;
  return url.href;
 }catch{return null;}
}
export async function rememberGooglePhoto(c,userId,profile){
 if(profile?.email_verified!==true)return;
 const photo=googleProfilePhoto(profile);
 const name=typeof profile.name==='string'?profile.name.trim().slice(0,120):'';
 if(!photo&&name.length<2)return;
 await c.query('update users set google_photo_url=coalesce($1,google_photo_url),google_full_name=coalesce($4,google_full_name) where id=$2 and email=$3 and not is_demo_guest',[photo,userId,String(profile.email).trim().toLowerCase(),name.length>=2?name:null]);
}
