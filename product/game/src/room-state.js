import policy from '../public/room-policy.json' with { type: 'json' };

export function createRoomState({ id, title }) {
  return { id, title, policyId: policy.id, phase: 'lobby', screen: 'lobby', leaderId: null, members: [], revision: 0 };
}

export function joinRoom(state, member) {
  if (state.members.some(m => m.id === member.id)) return state;
  const limit = policy.rules.participantLimit.value;
  if (limit !== null && state.members.length >= limit) throw new Error('방의 참가 인원이 찼습니다.');
  const next = structuredClone(state);
  next.members.push({ ...member, ready: policy.rules.initialReady.value });
  next.leaderId ??= member.id;
  next.revision++;
  return next;
}

export function applyAction(state, actorId, action) {
  const member = state.members.find(m => m.id === actorId);
  if (!member) throw new Error('방에 입장한 뒤 다시 시도해 주세요.');
  if (action.type === 'start' || action.type === 'transfer') {
    if (actorId !== state.leaderId) throw new Error('현재 팀장만 실행할 수 있습니다.');
  }
  if (action.type === 'start' && state.phase === 'started') return state;
  if (state.phase !== 'lobby') throw new Error('트랙이 이미 시작되었습니다.');
  if (action.type === 'ready') {
    if (typeof action.ready !== 'boolean') throw new Error('준비 상태를 확인해 주세요.');
    if (member.ready === action.ready) return state;
  }
  const next = structuredClone(state);
  const actor = next.members.find(m => m.id === actorId);
  switch (action.type) {
    case 'ready':
      actor.ready = action.ready;
      break;
    case 'transfer': {
      if (action.targetId === actorId) throw new Error('다른 팀원을 선택해 주세요.');
      const target = next.members.find(m => m.id === action.targetId);
      if (!target) throw new Error('팀원을 찾을 수 없습니다.');
      next.leaderId = target.id;
      actor.ready = policy.rules.transferSenderReady.value;
      break;
    }
    case 'start':
      if (!next.members.every(m => m.ready)) throw new Error('모든 참가자가 준비 완료해야 시작할 수 있습니다.');
      next.phase = 'started';
      next.screen = 'track-start';
      break;
    default:
      throw new Error('지원하지 않는 동작입니다.');
  }
  next.revision++;
  return next;
}
