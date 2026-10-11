(async () => {
  const authorization = 'Bearer ' + sessionStorage.getItem('synthetic-uid');
  const list = await (await fetch('/api/inspections', {headers: {Authorization: authorization}})).json();
  const id = list.inspections.find(item => item.address === 'Synthetic review address')?.inspection_id;
  if (!id) return {error: 'Synthetic inspection not found'};
  const current = await (await fetch('/api/inspections/' + id, {headers: {Authorization: authorization}})).json();
  current.data.technician_notes = 'Remote tab changed this draft';
  const response = await fetch('/api/inspections/' + id, {
    method: 'PUT',
    headers: {Authorization: authorization, 'Content-Type': 'application/json'},
    body: JSON.stringify({expected_revision: current.revision, data: current.data})
  });
  return {id, before: current.revision, status: response.status, after: (await response.json()).revision};
})()
