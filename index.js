'use strict';

function filterKeysetColumns(model, keysetColumns) {
  // If only one keyset pagination column, use direct value as optimization
  if (keysetColumns.length === 1)
    return model[keysetColumns[0][0]];

  const result = {};
  keysetColumns.map(x => {
    result[x[0]] = model[x[0]];
  });
  return result;
}

function generateWhereCondition(query, seek, compositeColumns = [], compositeValues = []) {
  if (seek.length === 0)
    return query.where(false);
  if (seek.length === 1)
    return query.where(seek[0].col, seek[0].reverse ? '<' : '>', seek[0].value);

  return query.where(seek[0].col, seek[0].reverse ? '<=' : '>=', seek[0].value)
    .andWhere(function () {
      const first = seek[0];

      this.where(first.col, first.reverse ? '<' : '>', first.value)
        .orWhere(function() {
          this.whereComposite(compositeColumns, compositeValues);
          generateWhereCondition(this, seek.slice(1),
                                 [first.col, ...compositeColumns],
                                 [first.value, ...compositeValues]);
        });
    });
};

module.exports = options => {
  // Default options
  options = Object.assign(
    {
      limit: 10,
      countTotal: false
    },
    options
  );

  return Model => {
    class KeysetPaginationQueryBuilder extends Model.QueryBuilder {
      keysetPage(keyset, reversed) {
        if (typeof keyset === 'string')
          keyset = JSON.parse(keyset);
        const keysetColumns = [];
        this.forEachOperation('orderBy', function(op) {
          if (Array.isArray(op.args[0])) {
            op.args[0].forEach(function (column, i) {
              if (typeof column === 'string') {
                keysetColumns.push([column, 'asc']);
              } else {
                keysetColumns.push([column.column, (column.order || 'asc').toLowerCase()]);
              }
            });
          } else {
            keysetColumns.push([op.args[0], (op.args && op.args[1] || 'asc').toLowerCase()]);
          }
        });
        if (keysetColumns.length === 0) {
          const idColumn = this.modelClass().idColumn;
          this.orderBy(idColumn);
          if (typeof idColumn === 'string')
            keysetColumns.push([idColumn, 'asc']);
          else
            idColumn.map(col => {
              keysetColumns.push([col, 'asc']);
            });
        }
        if (reversed) {
          this.clear('orderBy');
          keysetColumns.map(op => {
            const [col, dir ] = op;
            this.orderBy(col, dir === 'asc' ? 'desc' : 'asc');
          });
        }

        if (options.countTotal)
          this.resultSizeBuilder = this.clone();

        if (!this.has(/limit/)) {
          this.limit(options.limit);
        }

        // Check if cursor (seek position) is given, use that as WHERE condition
        if (keyset) {
          let seekPosition = reversed ? keyset.first : keyset.last;
          if (seekPosition) {

            // Optimization for one key, see filterKeysetColumns for reverse operation
            if (keysetColumns.length === 1) {
              let col = keysetColumns[0];
              var seekPositionNew = {};
              seekPositionNew[col[0]] = seekPosition;
              seekPosition = seekPositionNew;
            }

            const missingColumns = keysetColumns.reduce((acc, col) => {
              if (typeof seekPosition === 'object' && !(col[0] in seekPosition))
                acc.push(col[0]);
              return acc;
            }, []);
            if (missingColumns.length > 0)
              throw TypeError(`Cursor seek position is missing keys: ${missingColumns}`);

            generateWhereCondition(this, keysetColumns.map(c => {
              return {
                col: c[0],
                value: seekPosition[c[0]],
                reverse: c[1] === (reversed ? 'asc' : 'desc')
              };
            }));
          }
        }

        this.runAfter((models, queryBuilder) => {
          const getCursorKey = args => filterKeysetColumns(args, keysetColumns);
          const keysetNew = models.length > 0
                ? {first: getCursorKey(models[reversed ? (models.length-1) : 0]),
                   last: getCursorKey(models[reversed ? 0 : (models.length-1)])}
                : keyset;

          if (this.resultSizeBuilder)
            return this.resultSizeBuilder.resultSize().then(
              resultSize => {
                return {
                  results: models,
                  keyset: keysetNew,
                  total: parseInt(resultSize , 10)
                };
              });

          return {
            results: models,
            keyset: keysetNew
          };
        });

        return this;
      };
      previousKeysetPage(keyset) {
        return this.keysetPage(keyset, true);
      }
    }

    return class extends Model {
      static get QueryBuilder() {
        return KeysetPaginationQueryBuilder;
      }
    };
  };
};
