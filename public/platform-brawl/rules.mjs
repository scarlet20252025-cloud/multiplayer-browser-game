export const BRAWL_RUNTIME = 'platform-brawl';
export const BRAWL_SOCKET = '/brawl-match';
export const MIN_BRAWL_PLAYERS = 2;
export const MAX_BRAWL_PLAYERS = 6;
export const TICK_RATE = 60;
export const WIDTH = 960;
export const HEIGHT = 550;
export const SCORE_TO_WIN = 5;

export {BRAWL_RUNTIME as RUNTIME, BRAWL_SOCKET as SOCKET, TICK_RATE as BRAWL_TICK_RATE};

// Roofs are one-way: fighters can jump up through the underside and land from above.
export const PLATFORMS = Object.freeze([
  Object.freeze({x:160,y:427,width:640,height:28}),
  Object.freeze({x:151,y:302,width:177,height:21}),
  Object.freeze({x:632,y:302,width:177,height:21}),
  Object.freeze({x:395,y:190,width:170,height:21}),
]);

export function normalizeBrawlInput(value){
  return {
    left:value?.left===true,
    right:value?.right===true,
    jump:value?.jump===true,
    light:value?.light===true,
    heavy:value?.heavy===true,
  };
}
