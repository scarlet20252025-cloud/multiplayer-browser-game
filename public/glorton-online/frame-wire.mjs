// This order is part of the wire format. It matches the engine's INPUT_FIELDS.
export const glortonControlFields=Object.freeze([
  'left','right','up_trace','down','jump_pressed','punch_pressed','special_pressed',
  'shield_pressed','shield_released',
]);
const maxMask=(1<<glortonControlFields.length)-1;

export function encodeGlortonFrame({controls,...packet}){
  const inputs=controls.map(seat=>glortonControlFields.reduce((mask,field,index)=>
    seat?.[field]===true?mask|(1<<index):mask,0));
  return {...packet,inputs};
}

export function decodeGlortonFrame(packet){
  if(packet?.op!=='frame'||!Object.hasOwn(packet,'inputs'))return packet;
  const {inputs,...frame}=packet;
  if(!Array.isArray(inputs)||inputs.length>4||inputs.some(mask=>
    !Number.isInteger(mask)||mask<0||mask>maxMask))throw Error('Invalid Glorton input masks');
  const controls=inputs.map(mask=>Object.fromEntries(glortonControlFields.map((field,index)=>
    [field,Boolean(mask&(1<<index))])));
  return {...frame,controls};
}
