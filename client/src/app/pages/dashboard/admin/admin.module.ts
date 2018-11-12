import { NgModule } from '@angular/core';

import {NotFoundModule} from '../../not-found/not-found.module';
import {MapQueueComponent} from './map-queue/map-queue.component';
import {ThemeModule} from '../../../@theme/theme.module';
import {QueuedMapComponent} from './map-queue/queued-map/queued-map.component';
import {AdminComponent} from './admin.component';
import {AdminRoutingModule} from './admin-routing.module';

@NgModule({
  imports: [
    ThemeModule,
    NotFoundModule,
    AdminRoutingModule,
  ],
  declarations: [
    MapQueueComponent,
    AdminComponent,
    QueuedMapComponent,
  ],
  providers: [],
})
export class AdminModule { }