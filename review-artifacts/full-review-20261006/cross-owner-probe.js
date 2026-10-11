(async () => {
  const owner = sessionStorage.getItem('synthetic-uid');
  const ownerToken = 'Bearer ' + owner;
  const otherToken = 'Bearer test-owner-other-review';
  const ownerList = await (await fetch('/api/inspections', {
    headers: {Authorization: ownerToken}
  })).json();
  const id = ownerList.inspections.find(item => item.address === 'Synthetic review address')?.inspection_id;
  if (!id) return {error: 'Synthetic draft not found', ownerList};
  const owned = await (await fetch('/api/inspections/' + id, {
    headers: {Authorization: ownerToken}
  })).json();
  const calls = [
    ['anonymous read', '/api/inspections/' + id, {}],
    ['other owner list', '/api/inspections', {headers: {Authorization: otherToken}}],
    ['other owner read', '/api/inspections/' + id, {headers: {Authorization: otherToken}}],
    ['other owner write', '/api/inspections/' + id, {
      method: 'PUT', headers: {Authorization: otherToken, 'Content-Type': 'application/json'},
      body: JSON.stringify({expected_revision: owned.revision, data: owned.data})
    }],
    ['other owner photo read', '/api/inspections/' + id + '/photos/test-photo', {
      headers: {Authorization: otherToken}
    }]
  ];
  const results = [];
  for (const [name, url, options] of calls) {
    const response = await fetch(url, options);
    let detail = '';
    try { detail = (await response.json()).detail || ''; } catch (_) {}
    results.push({name, status: response.status, detail});
  }
  return {inspectionId: id, results};
})()
