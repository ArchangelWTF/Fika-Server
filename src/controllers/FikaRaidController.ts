import { inject, injectable } from "tsyringe";

import { FikaMatchEndSessionMessage } from "../models/enums/FikaMatchEndSessionMessages";
import { IFikaRaidServerIdRequestData } from "../models/fika/routes/raid/IFikaRaidServerIdRequestData";
import { IFikaRaidCreateRequestData } from "../models/fika/routes/raid/create/IFikaRaidCreateRequestData";
import { IFikaRaidCreateResponse } from "../models/fika/routes/raid/create/IFikaRaidCreateResponse";
import { IFikaRaidGethostResponse } from "../models/fika/routes/raid/gethost/IFikaRaidGethostResponse";
import { IFikaRaidSettingsResponse } from "../models/fika/routes/raid/getsettings/IFikaRaidSettingsResponse";
import { IFikaRaidJoinRequestData } from "../models/fika/routes/raid/join/IFikaRaidJoinRequestData";
import { IFikaRaidJoinResponse } from "../models/fika/routes/raid/join/IFikaRaidJoinResponse";
import { IFikaRaidLeaveRequestData } from "../models/fika/routes/raid/leave/IFikaRaidLeaveRequestData";
import { FikaMatchService } from "../services/FikaMatchService";
import { FikaDedicatedRaidService } from "../services/dedicated/FikaDedicatedRaidService";
import { IStartDedicatedRequest } from "../models/fika/routes/raid/dedicated/IStartDedicatedRequest";
import { IStartDedicatedResponse } from "../models/fika/routes/raid/dedicated/IStartDedicatedResponse";
import { WebSocket } from "ws";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { IStatusDedicatedRequest } from "../models/fika/routes/raid/dedicated/IStatusDedicatedRequest";
import { IStatusDedicatedResponse } from "../models/fika/routes/raid/dedicated/IStatusDedicatedResponse";
import { IGetStatusDedicatedResponse } from "../models/fika/routes/raid/dedicated/IGetStatusDedicatedResponse";
import { FikaDedicatedRaidWebSocket } from "../websockets/FikaDedicatedRaidWebSocket";
import { IPmcData } from "@spt/models/eft/common/IPmcData";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";
import { IFikaRaidVerifyInsuredItemsRequestData } from "../models/fika/routes/raid/IFikaRaidVerifyInsuredItemsRequestData";
import { SaveServer } from "@spt/servers/SaveServer";
import { ISptProfile } from "@spt/models/eft/profile/ISptProfile";

@injectable()
export class FikaRaidController {
    constructor(
        @inject("FikaMatchService") protected fikaMatchService: FikaMatchService,
        @inject("FikaDedicatedRaidService") protected fikaDedicatedRaidService: FikaDedicatedRaidService,
        @inject("FikaDedicatedRaidWebSocket") protected fikaDedicatedRaidWebSocket: FikaDedicatedRaidWebSocket,
        @inject("ProfileHelper") protected profileHelper: ProfileHelper,
        @inject("WinstonLogger") protected logger: ILogger,
        @inject("SaveServer") protected saveServer: SaveServer,
    ) {
        // empty
    }

    /**
     * Handle /fika/raid/create
     * @param request
     */
    public handleRaidCreate(request: IFikaRaidCreateRequestData): IFikaRaidCreateResponse {
        return {
            success: this.fikaMatchService.createMatch(request),
        };
    }

    /**
     * Handle /fika/raid/join
     * @param request
     */
    public handleRaidJoin(request: IFikaRaidJoinRequestData): IFikaRaidJoinResponse {
        const match = this.fikaMatchService.getMatch(request.serverId);

        return {
            serverId: request.serverId,
            timestamp: match.timestamp,
            expectedNumberOfPlayers: match.expectedNumberOfPlayers,
            gameVersion: match.gameVersion,
            fikaVersion: match.fikaVersion,
            raidCode: match.raidCode,
        };
    }

    /**
     * Handle /fika/raid/leave
     * @param request
     */
    public handleRaidLeave(request: IFikaRaidLeaveRequestData): void {
        if (request.serverId === request.profileId) {
            this.fikaMatchService.endMatch(request.serverId, FikaMatchEndSessionMessage.HOST_SHUTDOWN_MESSAGE);
            return;
        }

        this.fikaMatchService.removePlayerFromMatch(request.serverId, request.profileId);
    }

    /**
     * Handle /fika/raid/gethost
     * @param request
     */
    public handleRaidGetHost(request: IFikaRaidServerIdRequestData): IFikaRaidGethostResponse {
        const match = this.fikaMatchService.getMatch(request.serverId);
        if (!match) {
            return;
        }

        return {
            ips: match.ips,
            port: match.port,
            natPunch: match.natPunch,
            isDedicated: match.isDedicated,
        };
    }

    /**
     * Handle /fika/raid/getsettings
     * @param request
     */
    public handleRaidGetSettings(request: IFikaRaidServerIdRequestData): IFikaRaidSettingsResponse {
        const match = this.fikaMatchService.getMatch(request.serverId);
        if (!match) {
            return;
        }

        return {
            metabolismDisabled: match.raidConfig.metabolismDisabled,
            playersSpawnPlace: match.raidConfig.playersSpawnPlace,
        };
    }

    /** Handle /fika/raid/dedicated/start */
    handleRaidStartDedicated(sessionID: string, info: IStartDedicatedRequest): IStartDedicatedResponse {
        if (!this.fikaDedicatedRaidService.isDedicatedClientAvailable()) {
            return {
                matchId: null,
                error: "No dedicated clients available.",
            };
        }

        if (sessionID in this.fikaDedicatedRaidService.dedicatedClients) {
            return {
                matchId: null,
                error: "A dedicated client is trying to use a dedicated client?",
            };
        }

        let dedicatedClient: string | undefined = undefined;
        let dedicatedClientWs: WebSocket | undefined = undefined;

        for (const dedicatedSessionId in this.fikaDedicatedRaidService.dedicatedClients) {
            const dedicatedClientInfo = this.fikaDedicatedRaidService.dedicatedClients[dedicatedSessionId];

            if (dedicatedClientInfo.state != "ready") {
                continue;
            }

            dedicatedClientWs = this.fikaDedicatedRaidWebSocket.clientWebSockets[dedicatedSessionId];

            if (!dedicatedClientWs) {
                continue;
            }

            dedicatedClient = dedicatedSessionId;
            break;
        }

        if (!dedicatedClient) {
            return {
                matchId: null,
                error: "No dedicated clients available at this time",
            };
        }

        const pmcDedicatedClientProfile: IPmcData = this.profileHelper.getPmcProfile(dedicatedClient);
        const requesterProfile: IPmcData = this.profileHelper.getPmcProfile(sessionID);

        this.logger.debug(`Dedicated: ${pmcDedicatedClientProfile.Info.Nickname} ${pmcDedicatedClientProfile.Info.Level} - Requester: ${requesterProfile.Info.Nickname} ${requesterProfile.Info.Level}`)

        //Set level of the dedicated profile to the person that has requested the raid to be started.
        pmcDedicatedClientProfile.Info.Level = requesterProfile.Info.Level;
        pmcDedicatedClientProfile.Info.Experience = requesterProfile.Info.Experience;

        this.fikaDedicatedRaidService.requestedSessions[dedicatedClient] = sessionID;

        dedicatedClientWs.send(
            JSON.stringify({
                type: "fikaDedicatedStartRaid",
                ...info,
            }),
        );

        this.logger.info(`Sent WS to ${dedicatedClient}`);

        return {
            // This really isn't required, I just want to make sure on the client
            matchId: dedicatedClient,
            error: null,
        };
    }

    /** Handle /fika/raid/dedicated/status */
    public handleRaidStatusDedicated(sessionId: string, info: IStatusDedicatedRequest): IStatusDedicatedResponse {
        if (info.status == "ready" && !this.fikaDedicatedRaidService.isDedicatedClientAvailable()) {
            if (this.fikaDedicatedRaidService.onDedicatedClientAvailable) {
                this.fikaDedicatedRaidService.onDedicatedClientAvailable();
            }
        }

        this.fikaDedicatedRaidService.dedicatedClients[sessionId] = {
            state: info.status,
            lastPing: Date.now(),
        };

        return {
            sessionId: info.sessionId,
            status: info.status,
        };
    }

    /** Handle /fika/raid/dedicated/getstatus */
    public handleRaidGetStatusDedicated(): IGetStatusDedicatedResponse {
        if (!this.fikaDedicatedRaidService.isDedicatedClientAvailable()) {
            return {
                available: false
            };
        } else {
            return {
                available: true
            };
        }
    }
    
    /**
     * Handle /fika/raid/verifyinsureditems
     * @param request
     */
    public handleRaidVerifyInsuredItems(request: IFikaRaidVerifyInsuredItemsRequestData): void {
        const profiles: Record<string, ISptProfile> = this.saveServer.getProfiles();
        if (!request.insuranceDatas) {
            return;
        }

        for (const profileId in request.insuranceDatas) {
            const profile = profiles[profileId];
            if (!profile) {
                continue;
            }

            const pickedUpItems = request.insuranceDatas[profileId];
            if (profile.characters?.pmc?.InsuredItems) {
                const newProfileInsuredItems = [];
                const profileInsuredItems = profile.characters.pmc.InsuredItems;
                for (const profileInsuredItem of profileInsuredItems) {
                    const foundItem = profile.characters.pmc.Inventory.items.find(i => i._id == profileInsuredItem.itemId);
                    if (!foundItem) {
                        continue;
                    }

                    if (!pickedUpItems.find(item => item.itemId == (foundItem.upd as any)?.PreviousID)) {
                        newProfileInsuredItems.push(profileInsuredItem);
                    }
                }

                profile.characters.pmc.InsuredItems = newProfileInsuredItems;
            }

            {
                const newInsurances = [];
                const insurances = [];
                for (const insurance of profile.insurance) {
                    const insuranceItems = [];
                    for (const profileInsuredItem of insurance.items) {
                        if (!pickedUpItems.find(item => item.itemId == (profileInsuredItem.upd as any)?.PreviousID)) {
                            insuranceItems.push(profileInsuredItem);
                        }
                    }

                    if (insurance.items.length > 0) {
                        insurance.items = insuranceItems;
                        insurances.push(insurance);
                    }
                }

                profile.insurance = newInsurances;
            }

        }

    }
}
