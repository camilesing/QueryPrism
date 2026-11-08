import { BaseChart } from '@/views/chat/component/BaseChart.ts'
import { Chart } from '@antv/g2'

// 工业蓝灰 HMI 分类色板：主色工业蓝打头，青/灰蓝为中性扩展，
// 绿/琥珀/红只作数据编码，语义与状态色规则一致。
const INDUSTRIAL_CATEGORY_PALETTE = [
  '#2563EB',
  '#0891B2',
  '#64748B',
  '#16A34A',
  '#F59E0B',
  '#DC2626',
]

export abstract class BaseG2Chart extends BaseChart {
  chart: Chart

  constructor(id: string, name: string) {
    super(id, name)
    this.chart = new Chart({
      container: id,
      autoFit: true,
      padding: 'auto',
    })

    this.chart.theme({
      view: {
        viewFill: '#FFFFFF',
      },
      category10: INDUSTRIAL_CATEGORY_PALETTE,
      axis: {
        lineStroke: '#CBD5E1',
        gridStroke: '#E2E8F0',
        labelFill: '#475569',
        titleFill: '#475569',
      },
    })
  }

  render() {
    this.chart?.render()
  }

  destroy() {
    this.chart?.destroy()
  }
}
