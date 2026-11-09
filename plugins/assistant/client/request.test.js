import assert from 'node:assert/strict';
import test from 'node:test';
import { localAssistantMutationHeaders, optimisticAssistantUserMessage } from './request.js';

test('image-only optimistic message retains its image snapshot after composer clears', () => {
  const attachments = [{ id:'image-id',url:'/api/account/images/image-id', draft:true }];
  const message = optimisticAssistantUserMessage('user-id','',attachments,123);
  attachments[0].url = 'changed'; attachments.length = 0;
  assert.deepEqual(message,{id:'user-id',role:'user',content:'',createdAt:123,images:[{id:'image-id',url:'/api/account/images/image-id'}]});
});

test('assistant mutations use the local session CSRF contract', () => {
  assert.deepEqual(localAssistantMutationHeaders('csrf-test'), {
    'Content-Type': 'application/json',
    'X-Requested-With': 'FlareTune',
    'X-CSRF-Token': 'csrf-test',
  });
  assert.throws(() => localAssistantMutationHeaders(''), /登录会话已失效/);
  assert.throws(() => localAssistantMutationHeaders(undefined), /登录会话已失效/);
});
