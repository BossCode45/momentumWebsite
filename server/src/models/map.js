'use strict';
const {
		sequelize, Op, Map, MapInfo, MapCredit, User, MapReview, MapImage,
		MapStats, MapZoneStats, MapTrack, MapTrackStats, MapZone, MapZoneTrigger,
		BaseStats, MapFavorite, MapZoneProperties,
		MapLibraryEntry, UserMapRank, Run
	} = require('../../config/sqlize'),
	user = require('./user'),
	activity = require('./activity'),
	queryHelper = require('../helpers/query'),
	mapImage = require('./map-image'),
	ServerError = require('../helpers/server-error'),
	config = require('../../config/config'),
	store_local = require('../helpers/filestore-local'),
	store_cloud = require('../helpers/filestore-cloud');

const storeMapFile = (mapFileBuffer, mapModel) => {
	const fileName = `maps/${mapModel.name}.bsp`;
	if (config.storage.useLocal) {
		return store_local.storeMapFileLocal(mapFileBuffer, fileName);
	}

	return store_cloud.storeFileCloud(mapFileBuffer, fileName);
};

const verifyMapNameNotTaken = (mapName) => {
	return Map.findOne({
		where: {
			name: mapName,
			statusFlag: {[Op.notIn]: [STATUS.REJECTED, STATUS.REMOVED]}
		},
		raw: true,
	}).then(mapWithSameName => {
		if (mapWithSameName)
			return Promise.reject(new ServerError(409, 'Map name already used'));
	});
};

const verifyMapUploadLimitNotReached = (submitterID) => {
	const mapUploadLimit = 5;
	return Map.count({
		where: {
			submitterID: submitterID,
			statusFlag: STATUS.PENDING,
		},
	}).then(count => {
		if (count >= mapUploadLimit)
			return Promise.reject(new ServerError(409, 'Map creation limit reached'));
	});
};

const onMapStatusUpdate = (mapID, previousStatus, newStatus, transaction) => {
	if (previousStatus === STATUS.PENDING && newStatus === STATUS.APPROVED)
		return onMapApproval(mapID, transaction);
};

const onMapApproval = (mapID, transaction) => {
	const authorIDs = [];
	return MapCredit.findAll({
		where: {mapID: mapID, type: CreditType.AUTHOR},
		raw: true,
	}).then(credits => {
		const activities = [];
		for (const credit of credits) {
			authorIDs.push(credit.userID);
			activities.push(
				activity.create({
					type: activity.ACTIVITY_TYPES.MAP_APPROVED,
					userID: credit.userID,
					data: mapID,
				}, transaction)
			);
		}
		if (activities.length)
			return Promise.all(activities);
		else
			return Promise.resolve();
	});
};

const STATUS = Object.freeze({
	APPROVED: 0,
	PENDING: 1,
	NEEDS_REVISION: 2,
	PRIVATE_TESTING: 3,
	PUBLIC_TESTING: 4,
	READY_FOR_RELEASE: 5,
	REJECTED: 6,
	REMOVED: 7,
});

const CreditType = Object.freeze({
	AUTHOR: 0,
	COAUTHOR: 1,
	TESTER: 2,
	SPECIAL_THANKS: 3,
});

const MAP_TYPE = Object.freeze({
	UNKNOWN: 0,
	SURF: 1,
	BHOP: 2,
	KZ: 3,
	RJ: 4,
	SJ: 5,
	TRICKSURF: 6,
	AHOP: 7,
	PARKOUR: 8,
	CONC: 9,
	DEFRAG: 10,
});

module.exports = {

	STATUS,
	CreditType,
	MAP_TYPE,

	getDefaultTickrateForMapType: (type) => {
		switch (type) {
			default:
			case MAP_TYPE.UNKNOWN:
			case MAP_TYPE.SURF:
			case MAP_TYPE.RJ:
			case MAP_TYPE.SJ:
			case MAP_TYPE.AHOP:
			case MAP_TYPE.PARKOUR:
				return 0.015;
			case MAP_TYPE.BHOP:
			case MAP_TYPE.TRICKSURF:
			case MAP_TYPE.CONC:
				return 0.01;
			case MAP_TYPE.DEFRAG:
				return 0.008;
			case MAP_TYPE.KZ:
				return 0.0078125;
		}
	},

	getAll: (userID, queryParams) => {
		const allowedExpansions = ['credits', 'thumbnail'];
		const queryOptions = {
			distinct: true,
			include: [
				{model: MapTrack, as: 'mainTrack', where: {trackNum: 0}, required: false},
				{model: MapInfo, as: 'info', where: {}},
			],
			where: {},
			limit: 100,
			order: [['createdAt', 'DESC']]
		};
		if (queryParams.limit)
			queryOptions.limit = queryParams.limit;
		if (queryParams.offset)
			queryOptions.offset = queryParams.offset;
		if (queryParams.submitterID)
			queryOptions.where.submitterID = queryParams.submitterID;
		if (queryParams.search)
			queryOptions.where.name = {[Op.like]: '%' + queryParams.search + '%'};
		if (queryParams.type) {
			queryOptions.where.type = queryParams.type;
		}
		if (queryParams.status && queryParams.statusNot) {
			queryOptions.where.statusFlag = {
				[Op.and]: {
					[Op.in]: queryParams.status.split(','),
					[Op.notIn]: queryParams.statusNot.split(','),
				}
			}
		} else if (queryParams.status) {
			queryOptions.where.statusFlag = {[Op.in]: queryParams.status.split(',')};
		} else if (queryParams.statusNot) {
			queryOptions.where.statusFlag = {[Op.notIn]: queryParams.statusNot.split(',')};
		}
		if ('priority' in queryParams || (queryParams.expand && queryParams.expand.includes('submitter'))) {
			queryOptions.include.push({
				model: User,
				as: 'submitter',
				where: {}
			});
		}
		if ('priority' in queryParams) {
			const priorityRoles = [
				user.Role.ADMIN,
				user.Role.MODERATOR,
				user.Role.MAPPER
			];
			const permChecks = [];
			for (let i = 0; i < priorityRoles.length; i++) {
				permChecks.push(
					sequelize.literal('roles & ' + priorityRoles[i]
						+ (queryParams.priority ? ' != ' : ' = ') + '0')
				);
			}
			queryOptions.include[2].where.roles = {
				[queryParams.priority ? Op.or : Op.and]: permChecks
			};
		}
		let difficultyOp = null;
		let diffs = [];
		if (queryParams.difficulty_low) {
			difficultyOp = Op.gte;
			diffs.push(queryParams.difficulty_low);
		}
		if (queryParams.difficulty_high) {
			if (difficultyOp)
				difficultyOp = Op.between;
			else
				difficultyOp = Op.lte;
			diffs.push(queryParams.difficulty_high);
		}
		if (difficultyOp) {
			queryOptions.include[0].where.difficulty = {
				[difficultyOp]: diffs,
			}
		}
		if (queryParams.layout && queryParams.layout > 0) {
			if (queryParams.layout === 1)
				queryOptions.include[0].where.isLinear = false;
			else if (queryParams.layout === 2)
				queryOptions.include[0].where.isLinear = true;
		}
		if (queryParams.expand) {
			queryHelper.addExpansions(queryOptions, queryParams.expand, allowedExpansions);
			const expansionNames = queryParams.expand.split(',');
			if (expansionNames.includes('inFavorites')) {
				queryOptions.include.push({
					model: MapFavorite,
					as: 'favorites',
					where: {userID: userID},
					required: false,
				});
			}
			if (expansionNames.includes('inLibrary')) {
				queryOptions.include.push({
					model: MapLibraryEntry,
					as: 'libraryEntries',
					where: {userID: userID},
					required: false,
				});
			}
			if (expansionNames.includes('personalBest')) {
				queryOptions.include.push({
					model: UserMapRank,
					as: 'personalBest',
					where: {userID: userID},
					include: [Run, User],
					required: false,
				});
			}
			if (expansionNames.includes('worldRecord')) {
				queryOptions.include.push({
					model: UserMapRank,
					as: 'worldRecord',
					where: {rank: 1},
					include: [Run, User],
					required: false,
				});
			}
		}
		return Map.findAndCountAll(queryOptions);
	},

	get: (mapID, userID, queryParams) => {
		const allowedExpansions = ['info', 'credits', 'submitter', 'images', 'thumbnail', 'mapStats'];
		const queryOptions = {include: [{model: MapTrack, as: 'mainTrack', required: false, where: {trackNum: 0}}]};
		if ('status' in queryParams)
			queryOptions.where.statusFlag = {[Op.in]: queryParams.status.split(',')};
		if (queryParams.expand) {
			queryHelper.addExpansions(queryOptions, queryParams.expand, allowedExpansions);
			const expansionNames = queryParams.expand.split(',');
			if (expansionNames.includes('inFavorites')) {
				queryOptions.include.push({
					model: MapFavorite,
					as: 'favorites',
					where: {userID: userID},
					required: false,
				});
			}
			if (expansionNames.includes('inLibrary')) {
				queryOptions.include.push({
					model: MapLibraryEntry,
					as: 'libraryEntries',
					where: {userID: userID},
					required: false,
				});
			}
			if (expansionNames.includes('personalBest')) {
				queryOptions.include.push({
					model: UserMapRank,
					as: 'personalBest',
					where: {userID: userID},
					include: [Run, User],
					required: false,
				});
			}
			if (expansionNames.includes('worldRecord')) {
				queryOptions.include.push({
					model: UserMapRank,
					as: 'worldRecord',
					where: {rank: 1},
					include: [Run, User],
					required: false,
				});
			}
			if (expansionNames.includes('tracks')) {
				queryOptions.include.push({
					model: MapTrack,
					as: 'tracks',
					required: false,
				});
			}
		}
		return Map.findByPk(mapID, queryOptions);
	},

	create: (map) => {
		return verifyMapUploadLimitNotReached(map.submitterID).then(() => {
			return verifyMapNameNotTaken(map.name);
		}).then(() => {
			return sequelize.transaction(t => {
				let mapMdl = null;
				return Map.create(map, {
					include: [
						{model: MapInfo, as: 'info'},
						{model: MapCredit, as: 'credits'},
						{
							model: MapStats,
							as: 'stats',
							include: [{model: BaseStats, as: 'baseStats'}],
						},
						{
							model: MapTrack,
							required: false,
							as: 'tracks',
							include: [
								{
									model: MapZone,
									as: 'zones',
									include: [
										{
											model: MapZoneStats,
											as: 'stats',
											include: [{model: BaseStats, as: 'baseStats'}]
										},
										{
											model: MapZoneTrigger,
											as: 'triggers',
											include: [{
												model: MapZoneProperties,
												as: 'zoneProps',
											}]
										}
									]
								},
								{
									model: MapTrackStats,
									as: 'stats',
									include: [{model: BaseStats, as: 'baseStats'}]
								}
							]
						}
					],
					transaction: t
				}).then(mapModel => {
					mapMdl = mapModel;
					// Set our mainTrack
					return MapTrack.findOne({
						where: {
							trackNum: 0,
							mapID: mapModel.id,
						},
						transaction: t,
					});
				}).then(mainTrack => {
					return mapMdl.update({
						mainTrack: mainTrack,
					}, {transaction: t})
				}).then(() => {
					if (map.credits && map.credits.length) {
						const activities = [];
						for (const credit of map.credits) {
							if (credit.type === CreditType.AUTHOR) {
								activities.push(
									activity.create({
										type: activity.ACTIVITY_TYPES.MAP_UPLOADED,
										userID: credit.userID,
										data: mapMdl.id,
									}, t)
								);
							}
						}
						return Promise.all(activities).then(() => {
							return Promise.resolve(mapMdl);
						});
					} else {
						return Promise.resolve(mapMdl);
					}
				});
			});
		});
	},

	update: (mapID, map) => {
		return sequelize.transaction(t => {
			return Map.findByPk(mapID, {
				where: {statusFlag: {[Op.notIn]: [STATUS.REJECTED, STATUS.REMOVED]}},
				transaction: t
			}).then(mapToUpdate => {
				if (mapToUpdate) {
					const previousMapStatus = mapToUpdate.statusFlag;
					return mapToUpdate.update(map, {
						transaction: t
					}).then(() => {
						if ('statusFlag' in map && previousMapStatus !== map.statusFlag)
							return onMapStatusUpdate(mapID, previousMapStatus, map.statusFlag, t);
						else
							return Promise.resolve();
					});
				}
			});
		});
	},

	delete: (mapID) => {
		return sequelize.transaction(t => {
			return MapImage.findAll({
				attributes: ['id'],
				where: {mapID: mapID},
				transaction: t,
			}).then(mapImages => {
				const mapImageFileDeletes = [];
				for (const image of mapImages)
					mapImageFileDeletes.push(mapImage.deleteMapImageFiles(image.id));
				return Promise.all(mapImageFileDeletes);
			}).then(() => {
				return Run.findAll({
					attributes: ['id'],
					where: {mapID: mapID},
					transaction: t,
				});
			}).then(runs => {
				const runFileDeletes = [];
				for (const r of runs)
					runFileDeletes.push(run.deleteRunFile(r.id)); // TODO: FIX THIS FUCKING CIRCULAR DEPENDENCY!!!
				return Promise.all(runFileDeletes);
			}).then(() => {
				return Map.destroy({
					where: {id: mapID},
					transaction: t,
				});
			});
		});
	},

	getInfo: (mapID) => {
		return MapInfo.findOne({
			where: {mapID: mapID},
			raw: true,
		});
	},

	updateInfo: (mapID, mapInfo) => {
		return MapInfo.update(mapInfo, {
			where: {mapID: mapID}
		});
	},

	getZones: (mapID) => {
		return Map.findByPk(mapID, {
			attributes: ['id', 'name', 'hash'],
			include: [{
				model: MapTrack,
				as: 'tracks',
				attributes: ['trackNum', 'numZones', 'isLinear', 'difficulty'],
				include: [{
					model: MapZone,
					as: 'zones',
					attributes: ['zoneNum'],
					include: [
						{
							model: MapZoneTrigger,
							as: 'triggers',
							attributes: ['type', 'pointsHeight', 'pointsZPos', 'points'],
							include: [{
								model: MapZoneProperties,
								as: 'zoneProps',
								attributes: ['properties'],
								required: false,
							}]
						},
					]
				}]
			}],
		}).then(mapMdl => {
			if (!mapMdl)
				return Promise.reject(new ServerError(404, 'Map not found'));

			return MapStats.update({totalPlays: sequelize.literal('totalPlays + 1')}, {
				where: {
					mapID: mapMdl.id,
				}
			}).then(() => {
				return Promise.resolve(mapMdl);
			});
		});
	},

	getCredits: (mapID, queryParams) => {
		const allowedExpansions = ['user'];
		const queryOptions = {where: {mapID: mapID}};
		queryHelper.addExpansions(queryOptions, queryParams.expand, allowedExpansions);
		return MapCredit.findAll(queryOptions);
	},

	verifySubmitter: (mapID, userID) => {
		return new Promise((resolve, reject) => {
			Map.findByPk(mapID, {
				raw: true,
			}).then(map => {
				if (map && map.submitterID === userID)
					resolve();
				else
					reject(new ServerError(403, 'Forbidden'));
			}).catch(reject);
		});
	},

	upload: (mapID, mapFileBuffer) => {
		let mapModel = null;
		return Map.findByPk(mapID).then(map => {
			if (!map)
				return Promise.reject(new ServerError(404, 'Map not found'));
			else if (map.statusFlag !== STATUS.NEEDS_REVISION)
				return Promise.reject(new ServerError(409, 'Map file cannot be uploaded given the map state'));
			mapModel = map;
			return storeMapFile(mapFileBuffer, map);
		}).then((results) => {
			return mapModel.update({
				statusFlag: STATUS.PENDING,
				downloadURL: results.downloadURL,
				hash: results.hash,
			});
		});
	},

	getFilePath: (mapID) => {
		return Map.findByPk(mapID, {
			raw: true,
		}).then(map => {
			if (!map)
				return Promise.reject(new ServerError(404, 'Map not found'));
			const filePath = `${__dirname}/../../public/maps/${map.name}.bsp`;
			return Promise.resolve(filePath);
		});
	},

	incrementDownloadCount: (mapID) => {
		MapStats.update({
			totalDownloads: sequelize.literal('totalDownloads + 1')
		}, {where: {mapID: mapID}});
	},

};
