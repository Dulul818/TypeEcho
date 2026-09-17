const {test}=require('node:test');
const assert=require('node:assert/strict');
const {updateWordFeedback}=require('../media/word-feedback');

test('completed mistakes, missing punctuation and extra letters survive transitions; correction replaces them',()=>{
  const history=new Map();
  const update=state=>updateWordFeedback(history,state);
  update({wordIndex:0,target:'hello,',typed:'hexlo'});
  update({wordIndex:1,target:'world',typed:'worldx'});
  assert.deepEqual(history.get(0).errors,[2,5]);
  update({wordIndex:2,target:'again',typed:''});
  assert.equal(history.get(1).extra,1);
  update({wordIndex:0,target:'hello,',typed:'hello,'});
  assert.deepEqual(history.get(0).errors,[]);
  update({wordIndex:1,target:'world',typed:'world'});
  assert.equal(history.get(1).extra,0);
  update({wordIndex:24,target:'new',typed:'',preview:[{index:23,text:'skip!',feedback:{complete:true,errors:[4],extra:0}}]});
  assert.deepEqual(history.get(23).errors,[4],'official feedback covers words missed between polls');
  update({wordIndex:25,target:'other',typed:''});
  assert.deepEqual(history.get(23).errors,[4],'official errors are not overwritten using absent typed text');
  update({wordIndex:23,target:'skip!',typed:'skip!'});
  assert.deepEqual(history.get(23).errors,[]);
  update({wordIndex:23,target:'different',typed:''});
  assert.equal(history.size,1,'changed round content clears old errors');
});
