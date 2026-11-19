import { describe, expect, it } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import { CharacterState, Direction, type Seat, TileType } from '../src/office/types.js';

function office(withAreas = true) {
  const os = new OfficeState({
    version: 1,
    cols: 16,
    rows: 10,
    tiles: new Array(160).fill(TileType.FLOOR_1),
    furniture: [],
  });
  for (const [uid, col, row] of [
    ['web', 2, 2],
    ['app', 8, 2],
    ['rest', 2, 7],
  ] as const) {
    const seat: Seat = {
      uid,
      seatCol: col,
      seatRow: row,
      facingDir: Direction.DOWN,
      assigned: false,
    };
    os.seats.set(uid, seat);
  }
  if (withAreas) {
    os.officeAreas = [
      { name: 'Web', rectangles: [{ col: 1, row: 1, width: 4, height: 3 }] },
      { name: 'App', rectangles: [{ col: 6, row: 1, width: 4, height: 3 }] },
      { name: 'Rest', rectangles: [{ col: 1, row: 6, width: 12, height: 3 }] },
    ];
    os.restArea = 'Rest';
    os.areaDestinations.set(1, 'Web');
  }
  os.addAgent(1, undefined, undefined, 'rest', true);
  return os;
}
const advance = (os: OfficeState, seconds = 20) => {
  for (let i = 0; i < seconds * 20; i++) os.update(0.05);
};
describe('office area walking', () => {
  it('walks to the work area, changes directory and returns to rest when waiting', () => {
    const os = office();
    const ch = os.characters.get(1)!;
    os.setAgentActive(1, true);
    os.update(0.05);
    expect(ch.seatId).toBe('web');
    expect(ch.state).toBe(CharacterState.WALK);
    expect(ch.tileRow).toBe(7);
    advance(os);
    expect(ch.tileRow).toBe(2);
    expect(ch.tileCol).toBe(2);
    os.areaDestinations.set(1, 'App');
    advance(os);
    expect(ch.seatId).toBe('app');
    expect(ch.tileCol).toBe(8);
    os.setAgentActive(1, false);
    advance(os);
    expect(ch.seatId).toBe('rest');
    expect(ch.tileRow).toBeGreaterThanOrEqual(6);
    expect(ch.tileRow).toBeLessThan(9);
    os.setAgentActive(1, true);
    advance(os);
    expect(ch.seatId).toBe('app');
  });
  it('uses rest when the work area is full; retries when a seat frees', () => {
    const os = office();
    os.seats.get('web')!.assigned = true;
    os.setAgentActive(1, true);
    advance(os);
    expect(os.characters.get(1)!.seatId).toBe('rest');
    os.seats.get('web')!.assigned = false;
    advance(os);
    expect(os.characters.get(1)!.seatId).toBe('web');
  });
  it('chooses the closest free reachable seat inside the work area', () => {
    const os = office();
    os.seats.set('near', {
      uid: 'near',
      seatCol: 2,
      seatRow: 3,
      facingDir: Direction.DOWN,
      assigned: false,
    });
    os.setAgentActive(1, true);
    advance(os);
    expect(os.characters.get(1)!.seatId).toBe('near');
  });
  it('walks to a rest tile when there are no seats, and keeps resting inside the area', () => {
    const os = office();
    os.seats.clear();
    const ch = os.characters.get(1)!;
    ch.seatId = null;
    ch.tileCol = 8;
    ch.tileRow = 2;
    ch.x = 136;
    ch.y = 40;
    os.setAgentActive(1, true);
    advance(os);
    expect(ch.seatId).toBeNull();
    expect(ch.tileRow).toBeGreaterThanOrEqual(6);
    os.setAgentActive(1, false);
    advance(os, 120);
    expect(ch.tileRow).toBeGreaterThanOrEqual(6);
    expect(ch.tileRow).toBeLessThan(9);
  });
  it('does not teleport to an unreachable free work seat', () => {
    const os = office();
    for (const [col, row] of [
      [1, 2],
      [3, 2],
      [2, 1],
      [2, 3],
    ])
      os.tileMap[row][col] = TileType.WALL;
    os.setAgentActive(1, true);
    advance(os);
    expect(os.characters.get(1)!.seatId).toBe('rest');
    expect(os.characters.get(1)!.tileRow).toBe(7);
  });
  it('preserves legacy assigned seats without external areas', () => {
    const os = office(false);
    os.setAgentActive(1, true);
    advance(os);
    expect(os.characters.get(1)!.seatId).toBe('rest');
  });
  it('reserves video seats for their named occupants and holds a finished seat briefly', () => {
    const os = office();
    os.officeAreas[0].workstations = [{ col: 2, row: 2, occupant: 'ElevenLabs' }];
    const ch = os.characters.get(1)!;
    ch.directoryName = 'Other';
    os.setAgentActive(1, true);
    advance(os);
    expect(ch.seatId).toBe('rest');
    ch.directoryName = 'ElevenLabs';
    advance(os);
    expect(ch.seatId).toBe('web');
    os.areaStayUntil.set(1, Date.now() + 60000);
    os.setAgentActive(1, false);
    advance(os);
    expect(ch.seatId).toBe('web');
    os.areaStayUntil.set(1, 0);
    advance(os);
    expect(ch.seatId).toBe('rest');
  });
});
