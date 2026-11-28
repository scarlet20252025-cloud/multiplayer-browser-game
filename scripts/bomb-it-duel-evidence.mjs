/** Detect the new original-game props created next to each human in Battle Royale. */
export function duelActionEffects(previousGrid, grid, positions) {
  if (!Array.isArray(previousGrid) || !Array.isArray(grid) || positions.length !== 2)
    return [];
  const changed = [];
  for (const [x, column] of grid.entries()) {
    for (const [y, cell] of column.entries()) {
      const prop = cell?.[3];
      if (typeof prop === 'string' && prop !== previousGrid[x]?.[y]?.[3])
        changed.push({x, y, prop});
    }
  }
  return positions.flatMap(([x, y], index) => {
    const found = changed.findIndex(cell => Math.abs(x - cell.x) + Math.abs(y - cell.y) <= 1);
    if (found < 0) return [];
    return [{seat: index + 1, ...changed.splice(found, 1)[0]}];
  });
}
