(async () => {
  window.fetch = async () => ({ok:true,json:async()=>({adr_estimate:{
    findings_html:'<p>Local review injection test</p><img src="invalid-review-image" onerror="window.reviewInjected=true">',
    recommendations_html:'<p>Synthetic review response only</p>',proposed_cost:2499
  }})});
  await runAuditAndSwitch();
  await new Promise(resolve=>setTimeout(resolve,100));
  return {injectedCodeExecuted:window.reviewInjected===true};
})()
