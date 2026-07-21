/** 加载旋转指示器：复用 .spinner（见 styles.css） */
export function Spinner({ size = 20, className = "" }: { size?: number; className?: string }) {
  return <span className={`spinner ${className}`.trim()} style={{ width: size, height: size }} />;
}
