(async () => {
  navigator.mediaDevices.getUserMedia = async () => {
    throw new DOMException('Review permission denied', 'NotAllowedError');
  };
  await startCamera();
  return {
    promptHidden: document.querySelector('#cameraPrompt').classList.contains('hidden'),
    overlayVisible: !document.querySelector('#arOverlay').classList.contains('hidden')
  };
})()
