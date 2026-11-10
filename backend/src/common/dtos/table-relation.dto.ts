import { IsInt, IsOptional, Min } from 'class-validator';

/** Body for `POST /table_relation/compare/:dsId` — which saved relation
 *  versions to diff. `to_version` defaults to the newest saved version. */
export class TableRelationCompareDto {
  @IsInt()
  @Min(1)
  from_version!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  to_version?: number;
}
