import { Suspense } from "react"
import { ImagesWorkbench } from "./workbench"

export const dynamic = 'force-dynamic'

export default function ImagesPage() {
  return (
    <Suspense fallback={<div>Loading images workbench...</div>}>
      <ImagesWorkbench />
    </Suspense>
  )
}