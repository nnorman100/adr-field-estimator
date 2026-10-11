(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 600;
  canvas.getContext('2d').fillRect(0, 0, 400, 600);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const file = new File([blob], 'synthetic-review.png', {type: 'image/png'});
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const input = document.querySelector('#photoFileInput');
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', {bubbles: true}));
  return {size: file.size, type: file.type, dimensions: [canvas.width, canvas.height]};
})()
