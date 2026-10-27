import { correctionCells, correctionState, projectRect, type CorrectionDocument, type CorrectionEdit } from "../../../../../shared/scanCorrection";
import type { SubjectiveQuestionNumber } from "../../../../../shared/types";
import { rotationTransform, rotationViewBox, RotatedCardImage, type ImageRotation } from "../RotatedCardImage";

export interface CorrectionCanvasProps {
  document: CorrectionDocument;
  pageIndex: number;
  edit: CorrectionEdit;
  images: Record<string, string>;
  zoom?: number;
  /** 原卷横放时的显示旋转（issue #347）：图片与热区同转，点选坐标不变。 */
  rotation?: ImageRotation;
  busy?: boolean;
  /** 存疑题号（置信度低于阈值）：未选中时用 amber 描边标出，点击即改。主观题号可以是题块编号字符串。 */
  reviewQuestions?: ReadonlySet<SubjectiveQuestionNumber>;
  onToggle: (cellId: string) => void;
}

/** 答题卡点选画布（内联版）。从 CardCorrectionEditor 抽出，供后处理页视图 2 与整卡改分弹窗共用。 */
export function CorrectionCanvas({ document, pageIndex, edit, images, zoom = 1, rotation = 0, busy = false, reviewQuestions, onToggle }: CorrectionCanvasProps) {
  const page = document.pages[pageIndex];
  if (!page) return null;
  const geometry = page.recognition.geometry;
  const state = correctionState(document.card, page, edit.selected, edit.touched);
  if (!geometry) return <RotatedCardImage src={images[page.sourceId]} alt="待重新识别的完整原卷" rotation={rotation} className="block w-full" />;
  return (
    <svg viewBox={rotationViewBox(geometry.imageWidth, geometry.imageHeight, rotation)} width={`${zoom * 100}%`} className="block max-w-none" aria-label={`第 ${page.layout.pageNumber} 页答题卡${rotation ? `（已旋转 ${rotation}°）` : ""}`}>
      <g transform={rotationTransform(geometry.imageWidth, geometry.imageHeight, rotation)}>
        <image href={images[page.sourceId]} width={geometry.imageWidth} height={geometry.imageHeight} />
        {correctionCells(page.layout).map(cell => {
          const selected = edit.selected.includes(cell.id);
          const invalid = state.invalid.has(cell.id);
          // 考号格没有题号，存疑标记只针对客观题与分数格
          const review = cell.type !== "student_digit" && !selected && reviewQuestions?.has(cell.questionNumber) === true;
          const label = cell.type === "student_digit" ? `学号第 ${cell.digitIndex + 1} 位 ${cell.digit}`
            : cell.type === "objective_option" ? `第 ${cell.questionNumber} 题 ${cell.option}`
            : `第 ${cell.questionNumber} 题 ${cell.score} 分`;
          return (
            <polygon
              key={cell.id}
              points={projectRect(cell.rect, geometry.layoutToImage)}
              data-cell-id={cell.id}
              data-cell-type={cell.type}
              role="button"
              aria-label={`${label}${selected ? (invalid ? "，异常" : "，已选") : review ? "，存疑" : ""}`}
              aria-pressed={selected}
              tabIndex={busy ? -1 : 0}
              vectorEffect="non-scaling-stroke"
              strokeWidth={selected ? 2 : review ? 1 : 0}
              className={`cursor-pointer fill-transparent outline-none ${
                selected
                  ? invalid ? "stroke-correction-error focus:stroke-3" : "stroke-correction-normal focus:stroke-3"
                  : review
                    ? "stroke-warning hover:stroke-info hover:stroke-1 focus:stroke-info focus:stroke-1"
                    : "stroke-transparent hover:stroke-info hover:stroke-1 focus:stroke-info focus:stroke-1"
              }`}
              onClick={() => onToggle(cell.id)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(cell.id); } }}
            >
              <title>{label}</title>
            </polygon>
          );
        })}
      </g>
    </svg>
  );
}
