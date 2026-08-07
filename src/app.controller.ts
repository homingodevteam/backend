import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiOkEnvelope } from './common/swagger/api-envelope.decorator';
import { AppService } from './app.service';

@ApiTags('App')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness placeholder' })
  @ApiOkEnvelope()
  getHello(): string {
    return this.appService.getHello();
  }
}
