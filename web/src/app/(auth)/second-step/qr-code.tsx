import qrcode from 'qrcode-generator';

// A QR code drawn as one SVG, from the text to encode. It is made in the browser, so the setup key
// inside it never goes to a server or an image service. Dark modules are one path; the quiet zone
// (four modules, as the QR standard asks) and the white background keep it scannable in dark mode.
export function QrCode({ text, label }: { text: string; label: string }) {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (code.isDark(row, column)) path += `M${column + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="mx-auto w-full max-w-60 rounded-md border border-input"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
