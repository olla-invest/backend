import { IsString, IsNotEmpty, IsIn, IsOptional } from 'class-validator';

export class MinuteCandleRequestDto {
  @IsString()
  @IsNotEmpty()
  stk_cd: string;

  @IsIn(['1', '3', '5', '10', '15', '30', '45', '60'])
  tic_scope: string;

  @IsIn(['0', '1'])
  upd_stkpc_tp: string = '1';
}

export class TickCandleRequestDto {
  @IsString()
  @IsNotEmpty()
  stk_cd: string;

  @IsIn(['1', '3', '5', '10', '30'])
  tic_scope: string;

  @IsIn(['0', '1'])
  upd_stkpc_tp: string = '1';
}

export class DayCandleRequestDto {
  @IsString()
  @IsNotEmpty()
  stk_cd: string;

  @IsString()
  @IsNotEmpty()
  base_dt: string; // YYYYMMDD

  @IsIn(['0', '1'])
  upd_stkpc_tp: string = '1';
}
